import type { IWorkloadSampleRepository } from '@main/domain/repositories';
import type { IWorkloadAnalyzer } from '@main/domain/services/workload-analyzer';
import type { WorkloadInsight } from '@shared/types/workload';

/** How far back to read samples when computing insights (6h). */
const LOOKBACK_MS = 6 * 60 * 60 * 1000;
/** Upper bound on samples loaded per request. */
const SAMPLE_LIMIT = 5000;

/**
 * Computes workload-pattern insights on demand from the recent sample window —
 * the same read-through approach as dashboard rankings. Insights are derived,
 * not stored, so they always reflect the latest collected activity.
 */
export class WorkloadService {
  constructor(
    private readonly sampleRepo: IWorkloadSampleRepository,
    private readonly analyzer: IWorkloadAnalyzer,
  ) {}

  async list(connectionId: string): Promise<WorkloadInsight[]> {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const samples = await this.sampleRepo.recent(connectionId, since, SAMPLE_LIMIT);
    return this.analyzer.analyze({ connectionId, samples });
  }
}
