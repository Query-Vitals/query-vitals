import type {
  IConnectionRepository,
  IQueryHistoryRepository,
  IRecommendationRepository,
  ISecretStore,
} from '@main/domain/repositories';
import type {
  IConnectorFactory,
  ExistingIndex,
} from '@main/domain/services/database-connector';
import type { IRecommendationEngine } from '@main/domain/services/recommendation-engine';
import type { Recommendation } from '@shared/types/recommendation';

export class RecommendationService {
  constructor(
    private readonly connections: IConnectionRepository,
    private readonly secrets: ISecretStore,
    private readonly factory: IConnectorFactory,
    private readonly queryRepo: IQueryHistoryRepository,
    private readonly recRepo: IRecommendationRepository,
    private readonly engine: IRecommendationEngine,
  ) {}

  /** Regenerate from current history + live indexes, persist, then return active. */
  async list(connectionId: string): Promise<Recommendation[]> {
    const config = await this.connections.get(connectionId);
    if (config) {
      try {
        const queries = await this.queryRepo.query({ connectionId, limit: 500 });
        const databases = [...new Set(queries.map((q) => q.databaseName).filter(Boolean))];
        const existingIndexes = await this.collectIndexes(connectionId, databases);
        const recs = this.engine.generateAll({ connectionId, queries, existingIndexes });
        if (recs.length) await this.recRepo.upsertMany(recs);
      } catch {
        // Connection unavailable — fall back to whatever is already stored.
      }
    }
    return this.recRepo.listActive(connectionId);
  }

  dismiss(id: string): Promise<void> {
    return this.recRepo.dismiss(id);
  }

  private async collectIndexes(connectionId: string, databases: string[]): Promise<ExistingIndex[]> {
    const config = await this.connections.get(connectionId);
    if (!config || databases.length === 0) return [];
    const password = config.passwordRef ? await this.secrets.get(config.passwordRef) : null;
    const connector = this.factory.create(config, password);
    await connector.connect();
    try {
      const all: ExistingIndex[] = [];
      for (const db of databases) {
        all.push(...(await connector.listIndexes(db)));
      }
      return all;
    } finally {
      await connector.disconnect();
    }
  }
}
