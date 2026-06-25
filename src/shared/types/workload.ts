/**
 * Workload-pattern insights (Phase 6).
 *
 * These describe performance problems that only appear *across* a burst of
 * queries rather than in any single statement: many individually-fast,
 * similarly-shaped point lookups that add up to a slow page, request, or job.
 * They are deliberately kept separate from index recommendations — the fix is
 * usually query orchestration (batching, joins, preloading), not another index.
 */

import type { DatabaseEngine } from './database';
import type { QueryType } from './query';
import type { RecommendationSeverity } from './recommendation';

/**
 * One poll-window observation of a single query fingerprint, captured by the
 * collector each tick. This is the raw temporal grain the analyzer groups into
 * bursts — `query_history` only stores all-time digests, so it cannot see the
 * short windows an N+1 pattern lives in.
 */
export interface WorkloadSample {
  id: string;
  connectionId: string;
  engine: DatabaseEngine;
  fingerprint: string;
  normalizedQuery: string;
  queryType: QueryType;
  databaseName: string;
  targetName: string;

  /** Start/end of the window this sample covers (ISO 8601). */
  windowStart: string;
  windowEnd: string;

  /** Executions of this fingerprint observed within the window. */
  executionCount: number;
  /** Cumulative wall-clock time across those executions (ms). */
  totalTimeMs: number;
  /** Total rows/documents examined and returned across the window. */
  rowsExamined: number;
  rowsReturned: number;
  /** Whether the executions used an index (collection/table scan otherwise). */
  usesIndex: boolean;
}

/** The kind of workload pattern detected. The first release ships N+1 only. */
export type WorkloadInsightKind = 'n-plus-one';

/**
 * A detected workload pattern, scored by total cost across a burst window.
 * Surfaced next to — but separate from — index recommendations.
 */
export interface WorkloadInsight {
  /** Deterministic id (connectionId + fingerprint + windowStart). */
  id: string;
  connectionId: string;
  engine: DatabaseEngine;
  kind: WorkloadInsightKind;
  severity: RecommendationSeverity;

  fingerprint: string;
  normalizedQuery: string;
  databaseName: string;
  targetName: string;
  queryType: QueryType;

  /** Executions in the burst and the burst's duration (ms). */
  executionCount: number;
  windowMs: number;
  windowFrom: string;
  windowTo: string;

  /** Cost figures the insight is scored by (cumulative, not per-query). */
  cumulativeTimeMs: number;
  avgExecutionTimeMs: number;
  rowsExamined: number;
  rowsReturned: number;

  /** True when the repeated query is already indexed ("indexed but repeated"). */
  usesIndex: boolean;
  /** True when the burst could be collapsed into one batched query. */
  batchingCandidate: boolean;

  /** Headline, e.g. "84 similar queries in 2.3s". */
  title: string;
  /** Why this burst was flagged, in plain language. */
  rationale: string;
  /** Engine-specific remediation, e.g. IN (...) / JOIN / preload vs $in / $lookup. */
  remediation: string;
}

/** Tunables for the (pure) workload analyzer. */
export interface WorkloadAnalysisOptions {
  /** Minimum executions in a burst before it is flagged. */
  minExecutions: number;
  /** Samples of one fingerprint within this gap (ms) merge into one burst. */
  burstGapMs: number;
  /** Per-execution time at/below which a query counts as "individually fast" (ms). */
  fastExecutionMs: number;
  /** Cap on the number of insights returned (highest cost first). */
  maxInsights: number;
}

export const DEFAULT_WORKLOAD_OPTIONS: WorkloadAnalysisOptions = {
  minExecutions: 10,
  burstGapMs: 30_000,
  fastExecutionMs: 50,
  maxInsights: 50,
};
