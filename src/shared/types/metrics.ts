/** Aggregated metrics that back the dashboard cards and charts. */

export interface DashboardMetrics {
  connectionId: string;
  windowFrom: string;
  windowTo: string;

  totalQueries: number;
  indexedQueries: number;
  nonIndexedQueries: number;
  slowQueries: number;
  averageQueryTimeMs: number;

  /** % of queries that touched an index (0..100). */
  indexCoveragePct: number;
}

export interface QueryTimePoint {
  timestamp: string;
  avgMs: number;
  count: number;
}

export interface TopQueryEntry {
  fingerprint: string;
  normalizedQuery: string;
  targetName: string;
  executionCount: number;
  avgExecutionTimeMs: number;
  maxExecutionTimeMs: number;
  fullScan: boolean;
  selectivity: number;
  performanceScore: number;
}

export type DashboardRanking =
  | 'slowest'
  | 'most-executed'
  | 'full-scans'
  | 'poor-selectivity';

/** Threshold above which a query is flagged "slow" (ms). User-configurable. */
export interface MonitoringSettings {
  slowQueryThresholdMs: number;
  pollIntervalMs: number;
  /** Max query records retained per connection before pruning. */
  historyRetentionLimit: number;
  /** Whether the analyzer auto-runs EXPLAIN on newly captured queries. */
  autoExplain: boolean;
}
