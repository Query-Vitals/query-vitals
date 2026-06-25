/**
 * CollectorManager — owns the lifecycle of one QueryCollector (and its
 * connected connector) per connection. Resolves the connection config and its
 * password, builds the connector, connects it, and hands back a collector the
 * monitoring service can start and subscribe to.
 */

import type {
  ICollectorManager,
  IQueryCollector,
} from '@main/domain/services/query-collector';
import type { IConnectorFactory, IDatabaseConnector } from '@main/domain/services/database-connector';
import type { IQueryAnalyzer } from '@main/domain/services/query-analyzer';
import type {
  IConnectionRepository,
  IQueryHistoryRepository,
  IWorkloadSampleRepository,
  ISecretStore,
} from '@main/domain/repositories';
import type { QueryRecord } from '@shared/types/query';
import type { DatabaseEngine } from '@shared/types/database';
import { QueryCollector } from './query-collector';

interface ManagerDeps {
  connectorFactory: IConnectorFactory;
  connectionRepo: IConnectionRepository;
  secretStore: ISecretStore;
  analyzer: IQueryAnalyzer;
  queryRepo: IQueryHistoryRepository;
  sampleRepo: IWorkloadSampleRepository;
}

const SOURCE_BY_ENGINE: Record<DatabaseEngine, QueryRecord['source']> = {
  mysql: 'mysql.performance_schema',
  mongodb: 'mongo.profiler',
};

export class CollectorManager implements ICollectorManager {
  private readonly collectors = new Map<string, IQueryCollector>();
  private readonly connectors = new Map<string, IDatabaseConnector>();

  constructor(private readonly deps: ManagerDeps) {}

  async ensure(connectionId: string): Promise<IQueryCollector> {
    const existing = this.collectors.get(connectionId);
    if (existing) return existing;

    const config = await this.deps.connectionRepo.get(connectionId);
    if (!config) throw new Error(`Connection not found: ${connectionId}`);

    const password = config.passwordRef
      ? await this.deps.secretStore.get(config.passwordRef)
      : null;

    const connector = this.deps.connectorFactory.create(config, password);
    await connector.connect();
    this.connectors.set(connectionId, connector);

    const collector = new QueryCollector(
      connectionId,
      connector,
      this.deps.analyzer,
      this.deps.queryRepo,
      this.deps.sampleRepo,
      SOURCE_BY_ENGINE[config.engine],
    );
    this.collectors.set(connectionId, collector);
    return collector;
  }

  get(connectionId: string): IQueryCollector | undefined {
    return this.collectors.get(connectionId);
  }

  async remove(connectionId: string): Promise<void> {
    const collector = this.collectors.get(connectionId);
    if (collector) await collector.stop();
    this.collectors.delete(connectionId);
    const connector = this.connectors.get(connectionId);
    if (connector) await connector.disconnect();
    this.connectors.delete(connectionId);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.collectors.keys()]) {
      await this.remove(id);
    }
  }
}
