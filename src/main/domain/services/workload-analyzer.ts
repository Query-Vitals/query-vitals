/**
 * IWorkloadAnalyzer — derives workload-pattern insights from per-window query
 * samples. The headline rule is deterministic N+1 detection: repeated
 * point-lookup bursts where one normalized query runs many times with different
 * literals inside a short window, cheap individually but costly in aggregate.
 *
 * Like the recommendation engine, the analyzer is pure: same samples + options
 * → same insights, so the burst-grouping and shape-detection logic is directly
 * unit-testable without a database.
 */

import type {
  WorkloadInsight,
  WorkloadSample,
  WorkloadAnalysisOptions,
} from '@shared/types/workload';

export interface WorkloadAnalysisInput {
  connectionId: string;
  /** Recent per-window samples for the connection, any order. */
  samples: WorkloadSample[];
  options?: Partial<WorkloadAnalysisOptions>;
}

export interface IWorkloadAnalyzer {
  /** Detect repeated point-lookup (N+1) bursts, scored by cumulative cost. */
  analyze(input: WorkloadAnalysisInput): WorkloadInsight[];
}
