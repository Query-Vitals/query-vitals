/**
 * IDatabaseConnector — the core port that abstracts MySQL and MongoDB behind a
 * single interface. Concrete adapters live in
 * `src/main/infrastructure/connectors/{mysql,mongodb}`.
 *
 * The rest of the application (collectors, analyzer, recommendation engine)
 * depends ONLY on this interface, never on mysql2 / mongodb directly. This is
 * the seam that keeps the domain engine-agnostic (clean architecture port).
 */

import type {
  ConnectionConfig,
  ConnectionTestResult,
  ConnectionStatus,
} from '@shared/types/database';
import type {
  IndexAnalysis,
  QueryRecord,
  ExecutionPlanNode,
} from '@shared/types/query';

/**
 * Aggregate metrics a collector can attach when the observability source
 * already reports them (e.g. MySQL performance_schema digests). When present,
 * the analyzer derives the verdict from these directly instead of running
 * EXPLAIN — which matters because a normalized/`?`-placeholder statement is not
 * itself runnable.
 */
export interface ObservedMetrics {
  /** How many times this digest ran in the window. */
  executionCount: number;
  /** Average rows examined per execution. */
  rowsExamined: number;
  /** Average rows returned/sent per execution. */
  rowsReturned: number;
  /** The source reported at least one execution that used no index. */
  noIndexUsed: boolean;
  /** The source reported a full table scan. */
  fullTableScan: boolean;
  maxExecutionTimeMs?: number;
}

/** A raw query observed by a collector, before normalization/analysis. */
export interface RawObservedQuery {
  rawQuery: string;
  databaseName: string;
  targetName?: string;
  executionTimeMs: number;
  timestamp: string;
  /** Optional pre-computed metrics from the observability source. */
  metrics?: ObservedMetrics;
}

/** Metadata about an existing index, used for redundancy/unused detection. */
export interface ExistingIndex {
  name: string;
  databaseName: string;
  targetName: string;
  fields: { name: string; direction: 1 | -1 }[];
  unique: boolean;
  /** Backs the primary key — never a drop candidate. */
  primary?: boolean;
  /** Access method (Postgres: btree, gin, gist, hash, …). Unset ⇒ btree-like. */
  method?: string;
  /** Index usage count (MongoDB $indexStats / Postgres idx_scan), if available. */
  accessCount?: number;
}

export interface ConnectorEvents {
  status: (status: ConnectionStatus) => void;
  error: (error: Error) => void;
}

/** Options for {@link IDatabaseConnector.explain}. */
export interface ExplainOptions {
  /** Execute the query to get actual figures (Postgres ANALYZE + BUFFERS). */
  analyze?: boolean;
}

/**
 * Lifecycle + capability contract every engine adapter implements.
 * All methods are async and must be safe to call after `connect()`.
 */
export interface IDatabaseConnector {
  readonly config: ConnectionConfig;
  readonly status: ConnectionStatus;

  /** Validate credentials and report server version + monitoring capability. */
  test(): Promise<ConnectionTestResult>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Run the engine's plan command for a query and normalize it.
   * MySQL: `EXPLAIN FORMAT=JSON ...`; Mongo: `explain("executionStats")`;
   * Postgres: `EXPLAIN (FORMAT JSON) ...`.
   *
   * `opts.analyze` asks for real execution figures where the engine supports
   * it (Postgres: `EXPLAIN (ANALYZE, BUFFERS)`). It EXECUTES the query, so it
   * is only used for explicit user-initiated inspection, never by collectors.
   * Engines without an analyze mode ignore the flag.
   */
  explain(rawQuery: string, databaseName: string, opts?: ExplainOptions): Promise<{
    plan: ExecutionPlanNode;
    rawPlan: unknown;
    analysis: IndexAnalysis;
  }>;

  /** List existing indexes for redundant/unused analysis. */
  listIndexes(databaseName: string, targetName?: string): Promise<ExistingIndex[]>;

  /**
   * Pull queries observed since the given checkpoint. Collectors call this on
   * each poll tick. Implementations track their own cursor where the engine
   * supports it (e.g. performance_schema event id, profiler ts).
   */
  collectSince(checkpoint: string | null): Promise<{
    queries: RawObservedQuery[];
    nextCheckpoint: string;
  }>;

  /** Subscribe to status/error transitions. Returns an unsubscribe fn. */
  on<E extends keyof ConnectorEvents>(event: E, handler: ConnectorEvents[E]): () => void;
}

/**
 * Factory that builds the right adapter for a connection config. The password
 * is passed explicitly (resolved from the secret store for saved connections,
 * or the plaintext entered for a pre-save "Test Connection").
 */
export interface IConnectorFactory {
  create(config: ConnectionConfig, password: string | null): IDatabaseConnector;
}

/** Partial record emitted by a connector before the analyzer enriches it. */
export type UnanalyzedQueryRecord = Omit<QueryRecord, 'analysis'>;
