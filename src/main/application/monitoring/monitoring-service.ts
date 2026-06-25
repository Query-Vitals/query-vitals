import type { ICollectorManager } from '@main/domain/services/query-collector';
import type { ISettingsRepository } from '@main/domain/repositories';
import type { IEventBus } from '@main/ipc/event-bus';
import type { MonitoringSettings } from '@shared/types/metrics';

export class MonitoringService {
  private readonly wired = new Set<string>();

  constructor(
    private readonly collectors: ICollectorManager,
    private readonly settings: ISettingsRepository,
    private readonly events: IEventBus,
  ) {}

  async start(connectionId: string): Promise<void> {
    const collector = await this.collectors.ensure(connectionId);
    if (!this.wired.has(connectionId)) {
      collector.on('queries', (records) => this.events.emitQueriesCaptured(records));
      collector.on('status', (status) => this.events.emitConnectionStatus(connectionId, status));
      // Push every collector lifecycle change so the UI's running flag stays in
      // sync (e.g. a poll error flips the collector to 'error' / not running).
      collector.on('state', (state) =>
        this.events.emitMonitoringState(connectionId, state === 'running'),
      );
      this.wired.add(connectionId);
    }
    const settings = await this.settings.getMonitoring(connectionId);
    await collector.start(settings);
    this.events.emitConnectionStatus(connectionId, 'connected');
    this.events.emitMonitoringState(connectionId, true);
  }

  async stop(connectionId: string): Promise<void> {
    await this.collectors.remove(connectionId);
    this.wired.delete(connectionId);
    this.events.emitConnectionStatus(connectionId, 'disconnected');
    this.events.emitMonitoringState(connectionId, false);
  }

  /** True when this connection's collector exists and is actively polling. */
  isRunning(connectionId: string): boolean {
    return this.collectors.get(connectionId)?.state === 'running';
  }

  getSettings(connectionId: string): Promise<MonitoringSettings> {
    return this.settings.getMonitoring(connectionId);
  }

  saveSettings(connectionId: string, settings: MonitoringSettings): Promise<void> {
    return this.settings.saveMonitoring(connectionId, settings);
  }
}
