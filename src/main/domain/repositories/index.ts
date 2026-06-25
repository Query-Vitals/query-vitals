/**
 * Repository ports. Concrete implementations (SQLite via sql.js/WASM, plus
 * the OS keychain for secrets) live in `src/main/infrastructure/persistence`.
 * The application layer depends only on these interfaces.
 */

import type { ConnectionConfig } from '@shared/types/database';
import type { QueryRecord } from '@shared/types/query';
import type { Recommendation } from '@shared/types/recommendation';
import type { WorkloadSample } from '@shared/types/workload';
import type {
  DashboardMetrics,
  DashboardRanking,
  MonitoringSettings,
  QueryTimePoint,
  TopQueryEntry,
} from '@shared/types/metrics';

export interface IConnectionRepository {
  list(): Promise<ConnectionConfig[]>;
  get(id: string): Promise<ConnectionConfig | null>;
  /** Insert or update by id. */
  save(config: ConnectionConfig): Promise<ConnectionConfig>;
  delete(id: string): Promise<void>;
}

export interface QueryHistoryFilter {
  connectionId: string;
  from?: string;
  to?: string;
  onlyFullScans?: boolean;
  onlyNonIndexed?: boolean;
  minExecutionTimeMs?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface IQueryHistoryRepository {
  /** Upsert a digest, merging counts/avg if the fingerprint already exists. */
  upsert(record: QueryRecord): Promise<void>;
  bulkUpsert(records: QueryRecord[]): Promise<void>;
  get(id: string): Promise<QueryRecord | null>;
  query(filter: QueryHistoryFilter): Promise<QueryRecord[]>;
  ranking(connectionId: string, ranking: DashboardRanking, limit: number): Promise<TopQueryEntry[]>;
  timeSeries(connectionId: string, from: string, to: string, bucketMs: number): Promise<QueryTimePoint[]>;
  metrics(connectionId: string, from: string, to: string): Promise<DashboardMetrics>;
  /** Drop oldest rows beyond the retention limit. */
  prune(connectionId: string, retentionLimit: number): Promise<number>;
}

export interface IRecommendationRepository {
  upsertMany(recs: Recommendation[]): Promise<void>;
  listActive(connectionId: string): Promise<Recommendation[]>;
  dismiss(id: string): Promise<void>;
}

/**
 * Per-poll-window query observations backing the workload analyzer. Each row is
 * one fingerprint's activity within a single collector tick.
 */
export interface IWorkloadSampleRepository {
  bulkInsert(samples: WorkloadSample[]): Promise<void>;
  /** Samples whose window ends at/after `since`, newest first, capped by limit. */
  recent(connectionId: string, since: string, limit: number): Promise<WorkloadSample[]>;
  /** Drop samples older than `before` (ISO). Returns rows removed. */
  prune(connectionId: string, before: string): Promise<number>;
}

export interface ISettingsRepository {
  getMonitoring(connectionId: string): Promise<MonitoringSettings>;
  saveMonitoring(connectionId: string, settings: MonitoringSettings): Promise<void>;
}

/** Stores connection passwords in the OS keychain, not in SQLite. */
export interface ISecretStore {
  set(ref: string, secret: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}
