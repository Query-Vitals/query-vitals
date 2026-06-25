/**
 * Composition root. The ONLY place where concrete infrastructure classes are
 * instantiated and wired to the application services. Everything downstream
 * receives interfaces, keeping the dependency graph pointing inward.
 */

import { join } from 'node:path';

import { SqliteDatabase } from '@main/infrastructure/persistence/database';
import { applySchema } from '@main/infrastructure/persistence/schema';
import { SqliteConnectionRepository } from '@main/infrastructure/persistence/connection-repository';
import { SqliteQueryHistoryRepository } from '@main/infrastructure/persistence/query-history-repository';
import { SqliteSettingsRepository } from '@main/infrastructure/persistence/settings-repository';
import { SqliteRecommendationRepository } from '@main/infrastructure/persistence/recommendation-repository';
import { SqliteWorkloadSampleRepository } from '@main/infrastructure/persistence/workload-sample-repository';
import { SafeStorageSecretStore } from '@main/infrastructure/persistence/secret-store';
import { ConnectorFactory } from '@main/infrastructure/connectors/connector-factory';
import { CollectorManager } from '@main/infrastructure/collectors/collector-manager';
import { QueryAnalyzer } from '@main/application/analysis/query-analyzer';
import { RecommendationEngine } from '@main/application/recommendations/recommendation-engine';
import { WorkloadAnalyzer } from '@main/application/workload/workload-analyzer';
import { ConnectionService } from '@main/application/connections/connection-service';
import { MonitoringService } from '@main/application/monitoring/monitoring-service';
import { AnalysisService } from '@main/application/analysis/analysis-service';
import { RecommendationService } from '@main/application/recommendations/recommendation-service';
import { WorkloadService } from '@main/application/workload/workload-service';
import { EventBus } from '@main/ipc/event-bus';

import type { IQueryHistoryRepository } from '@main/domain/repositories';

export interface AppContainer {
  db: SqliteDatabase;
  eventBus: EventBus;
  queryRepo: IQueryHistoryRepository;
  connectionService: ConnectionService;
  monitoringService: MonitoringService;
  analysisService: AnalysisService;
  recommendationService: RecommendationService;
  workloadService: WorkloadService;
  dispose(): Promise<void>;
}

export async function buildContainer(userDataDir: string): Promise<AppContainer> {
  const db = await SqliteDatabase.open(join(userDataDir, 'query-vitals.db'));
  applySchema(db);

  // Repositories + infrastructure (concretes constructed only here).
  const connectionRepo = new SqliteConnectionRepository(db);
  const queryRepo = new SqliteQueryHistoryRepository(db);
  const settingsRepo = new SqliteSettingsRepository(db);
  const recommendationRepo = new SqliteRecommendationRepository(db);
  const workloadSampleRepo = new SqliteWorkloadSampleRepository(db);
  const secretStore = new SafeStorageSecretStore(db);
  const connectorFactory = new ConnectorFactory();
  const analyzer = new QueryAnalyzer();
  const recommendationEngine = new RecommendationEngine();
  const workloadAnalyzer = new WorkloadAnalyzer();
  const eventBus = new EventBus();

  const collectorManager = new CollectorManager({
    connectorFactory,
    connectionRepo,
    secretStore,
    analyzer,
    queryRepo,
    sampleRepo: workloadSampleRepo,
  });

  // Application services (depend only on interfaces above).
  const connectionService = new ConnectionService(connectionRepo, secretStore, connectorFactory);
  const monitoringService = new MonitoringService(collectorManager, settingsRepo, eventBus);
  const analysisService = new AnalysisService(
    connectionRepo,
    secretStore,
    connectorFactory,
    analyzer,
    queryRepo,
  );
  const recommendationService = new RecommendationService(
    connectionRepo,
    secretStore,
    connectorFactory,
    queryRepo,
    recommendationRepo,
    recommendationEngine,
  );
  const workloadService = new WorkloadService(workloadSampleRepo, workloadAnalyzer);

  return {
    db,
    eventBus,
    queryRepo,
    connectionService,
    monitoringService,
    analysisService,
    recommendationService,
    workloadService,
    async dispose() {
      await collectorManager.stopAll();
      db.close();
    },
  };
}
