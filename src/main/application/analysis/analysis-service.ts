import type {
  IConnectionRepository,
  IQueryHistoryRepository,
  ISecretStore,
} from '@main/domain/repositories';
import type { IConnectorFactory } from '@main/domain/services/database-connector';
import type { IQueryAnalyzer } from '@main/domain/services/query-analyzer';
import type { QueryRecord } from '@shared/types/query';

export class AnalysisService {
  constructor(
    private readonly connections: IConnectionRepository,
    private readonly secrets: ISecretStore,
    private readonly factory: IConnectorFactory,
    private readonly analyzer: IQueryAnalyzer,
    private readonly queryRepo: IQueryHistoryRepository,
  ) {}

  /** Ad-hoc: run EXPLAIN on a concrete query the user pasted in. */
  async explain(connectionId: string, rawQuery: string): Promise<QueryRecord> {
    const config = await this.connections.get(connectionId);
    if (!config) throw new Error(`Connection not found: ${connectionId}`);
    const password = config.passwordRef ? await this.secrets.get(config.passwordRef) : null;
    const connector = this.factory.create(config, password);
    await connector.connect();
    try {
      const record = await this.analyzer.toRecord(
        {
          rawQuery,
          databaseName: config.database ?? '',
          executionTimeMs: 0,
          timestamp: new Date().toISOString(),
        },
        connector,
        'manual',
      );
      await this.queryRepo.upsert(record);
      return record;
    } finally {
      await connector.disconnect();
    }
  }
}
