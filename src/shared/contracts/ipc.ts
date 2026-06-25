/**
 * The typed contract between the renderer (React UI) and the main process
 * (Node backend). The preload script exposes `window.api` implementing
 * `IpcApi`; the main process registers matching handlers. Channel name
 * constants keep both sides in sync and prevent typos.
 */

import type {
  ConnectionConfig,
  ConnectionTestResult,
} from '@shared/types/database';
import type { QueryRecord } from '@shared/types/query';
import type { Recommendation } from '@shared/types/recommendation';
import type { WorkloadInsight } from '@shared/types/workload';
import type {
  DashboardMetrics,
  DashboardRanking,
  MonitoringSettings,
  QueryTimePoint,
  TopQueryEntry,
} from '@shared/types/metrics';
import type { QueryHistoryFilter } from '@main/domain/repositories';

export const IpcChannels = {
  connections: {
    list: 'connections:list',
    test: 'connections:test',
    capabilities: 'connections:capabilities',
    save: 'connections:save',
    delete: 'connections:delete',
  },
  monitoring: {
    start: 'monitoring:start',
    stop: 'monitoring:stop',
    status: 'monitoring:status',
    getSettings: 'monitoring:getSettings',
    saveSettings: 'monitoring:saveSettings',
  },
  queries: {
    list: 'queries:list',
    get: 'queries:get',
    explain: 'queries:explain', // ad-hoc analysis of a pasted query
  },
  dashboard: {
    metrics: 'dashboard:metrics',
    ranking: 'dashboard:ranking',
    timeSeries: 'dashboard:timeSeries',
  },
  recommendations: {
    list: 'recommendations:list',
    dismiss: 'recommendations:dismiss',
  },
  workload: {
    list: 'workload:list',
  },
  /** Main → renderer push events (collector ticks, status changes). */
  events: {
    queriesCaptured: 'events:queriesCaptured',
    connectionStatus: 'events:connectionStatus',
    monitoringState: 'events:monitoringState',
  },
} as const;

/** Request/response surface invoked from the renderer. */
export interface IpcApi {
  connections: {
    list(): Promise<ConnectionConfig[]>;
    test(config: ConnectionConfig, password?: string): Promise<ConnectionTestResult>;
    /** Re-check a saved connection's monitoring capabilities (uses stored secret). */
    capabilities(connectionId: string): Promise<ConnectionTestResult>;
    save(config: ConnectionConfig, password?: string): Promise<ConnectionConfig>;
    delete(id: string): Promise<void>;
  };
  monitoring: {
    start(connectionId: string): Promise<void>;
    stop(connectionId: string): Promise<void>;
    /** Whether the collector for this connection is currently running. */
    status(connectionId: string): Promise<boolean>;
    getSettings(connectionId: string): Promise<MonitoringSettings>;
    saveSettings(connectionId: string, settings: MonitoringSettings): Promise<void>;
  };
  queries: {
    list(filter: QueryHistoryFilter): Promise<QueryRecord[]>;
    get(id: string): Promise<QueryRecord | null>;
    explain(connectionId: string, rawQuery: string): Promise<QueryRecord>;
  };
  dashboard: {
    metrics(connectionId: string, from: string, to: string): Promise<DashboardMetrics>;
    ranking(connectionId: string, ranking: DashboardRanking, limit: number): Promise<TopQueryEntry[]>;
    timeSeries(connectionId: string, from: string, to: string, bucketMs: number): Promise<QueryTimePoint[]>;
  };
  recommendations: {
    list(connectionId: string): Promise<Recommendation[]>;
    dismiss(id: string): Promise<void>;
  };
  workload: {
    /** Workload-pattern insights (e.g. N+1 bursts) for the connection. */
    list(connectionId: string): Promise<WorkloadInsight[]>;
  };
  /** Subscribe to a push event; returns an unsubscribe function. */
  on(channel: 'events:queriesCaptured', cb: (records: QueryRecord[]) => void): () => void;
  on(channel: 'events:connectionStatus', cb: (p: { connectionId: string; status: string }) => void): () => void;
  on(channel: 'events:monitoringState', cb: (p: { connectionId: string; running: boolean }) => void): () => void;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
