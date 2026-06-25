/**
 * IQueryAnalyzer — turns a raw observed query into a fully analyzed
 * QueryRecord: normalizes the statement, computes a fingerprint, derives the
 * index analysis (from collector-provided metrics when present, otherwise by
 * running EXPLAIN via the connector), and scores the result.
 */

import type { DatabaseEngine } from '@shared/types/database';
import type { IndexAnalysis, QueryRecord, QueryType } from '@shared/types/query';
import type { RawObservedQuery, IDatabaseConnector } from './database-connector';

export interface NormalizedStatement {
  normalizedQuery: string;
  fingerprint: string;
  queryType: QueryType;
  databaseName: string;
  targetName: string;
  relatedTargets: string[];
}

export interface AnalyzeOptions {
  /** Slow-query threshold (ms) used for the latency factor of the score. */
  slowThresholdMs?: number;
}

export interface IQueryAnalyzer {
  /**
   * Replace literals with placeholders and derive a stable fingerprint so that
   * repeated runs of the same statement collapse into one digest.
   */
  normalize(raw: RawObservedQuery, engine: DatabaseEngine): NormalizedStatement;

  /** Produce the index analysis, using metrics if present else EXPLAIN. */
  analyze(
    raw: RawObservedQuery,
    connector: IDatabaseConnector,
    opts?: AnalyzeOptions,
  ): Promise<IndexAnalysis>;

  /** Convenience: normalize + analyze into a complete record. */
  toRecord(
    raw: RawObservedQuery,
    connector: IDatabaseConnector,
    source: QueryRecord['source'],
    opts?: AnalyzeOptions,
  ): Promise<QueryRecord>;
}
