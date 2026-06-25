/**
 * IQueryCollector — a long-running poller that pulls observed queries from a
 * connection on an interval, hands them to the analyzer, and persists the
 * resulting digests. One collector instance per active connection.
 */

import type { QueryRecord } from '@shared/types/query';
import type { MonitoringSettings } from '@shared/types/metrics';
import type { ConnectionStatus } from '@shared/types/database';

export type CollectorState = 'idle' | 'running' | 'paused' | 'error';

export interface CollectorEvents {
  /** Emitted after each poll tick with the newly analyzed records. */
  queries: (records: QueryRecord[]) => void;
  state: (state: CollectorState) => void;
  status: (status: ConnectionStatus) => void;
  error: (error: Error) => void;
}

export interface IQueryCollector {
  readonly connectionId: string;
  readonly state: CollectorState;

  start(settings: MonitoringSettings): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;

  on<E extends keyof CollectorEvents>(event: E, handler: CollectorEvents[E]): () => void;
}

/** Manages the lifecycle of all per-connection collectors. */
export interface ICollectorManager {
  ensure(connectionId: string): Promise<IQueryCollector>;
  get(connectionId: string): IQueryCollector | undefined;
  /** Stop a collector and disconnect its connector. */
  remove(connectionId: string): Promise<void>;
  stopAll(): Promise<void>;
}
