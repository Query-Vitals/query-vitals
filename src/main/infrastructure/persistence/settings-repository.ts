import type { ISettingsRepository } from '@main/domain/repositories';
import type { MonitoringSettings } from '@shared/types/metrics';
import type { SqliteDatabase } from './database';
import { DEFAULT_MONITORING_SETTINGS } from './schema';

export class SqliteSettingsRepository implements ISettingsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async getMonitoring(connectionId: string): Promise<MonitoringSettings> {
    const row = this.db.get('SELECT * FROM settings WHERE connection_id = ?', [connectionId]);
    if (!row) return { ...DEFAULT_MONITORING_SETTINGS };
    return {
      slowQueryThresholdMs: Number(row['slow_query_threshold_ms']),
      pollIntervalMs: Number(row['poll_interval_ms']),
      historyRetentionLimit: Number(row['history_retention_limit']),
      autoExplain: Number(row['auto_explain']) === 1,
    };
  }

  async saveMonitoring(connectionId: string, s: MonitoringSettings): Promise<void> {
    this.db.run(
      `INSERT INTO settings
        (connection_id, slow_query_threshold_ms, poll_interval_ms,
         history_retention_limit, auto_explain)
       VALUES (?,?,?,?,?)
       ON CONFLICT(connection_id) DO UPDATE SET
         slow_query_threshold_ms=excluded.slow_query_threshold_ms,
         poll_interval_ms=excluded.poll_interval_ms,
         history_retention_limit=excluded.history_retention_limit,
         auto_explain=excluded.auto_explain`,
      [
        connectionId,
        s.slowQueryThresholdMs,
        s.pollIntervalMs,
        s.historyRetentionLimit,
        s.autoExplain ? 1 : 0,
      ],
    );
  }
}
