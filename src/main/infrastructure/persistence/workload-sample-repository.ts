import type { IWorkloadSampleRepository } from '@main/domain/repositories';
import type { WorkloadSample } from '@shared/types/workload';
import type { DatabaseEngine } from '@shared/types/database';
import type { QueryType } from '@shared/types/query';
import type { Row, SqliteDatabase } from './database';

export class SqliteWorkloadSampleRepository implements IWorkloadSampleRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async bulkInsert(samples: WorkloadSample[]): Promise<void> {
    if (!samples.length) return;
    this.db.transaction((tx) => {
      for (const s of samples) {
        tx.run(
          `INSERT INTO workload_samples
            (id, connection_id, engine, fingerprint, normalized_query, query_type,
             database_name, target_name, window_start, window_end,
             execution_count, total_time_ms, rows_examined, rows_returned, uses_index)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            s.id,
            s.connectionId,
            s.engine,
            s.fingerprint,
            s.normalizedQuery,
            s.queryType,
            s.databaseName,
            s.targetName,
            s.windowStart,
            s.windowEnd,
            s.executionCount,
            s.totalTimeMs,
            s.rowsExamined,
            s.rowsReturned,
            s.usesIndex ? 1 : 0,
          ],
        );
      }
    });
  }

  async recent(connectionId: string, since: string, limit: number): Promise<WorkloadSample[]> {
    return this.db
      .all(
        `SELECT * FROM workload_samples
         WHERE connection_id = ? AND window_end >= ?
         ORDER BY window_end DESC LIMIT ?`,
        [connectionId, since, limit],
      )
      .map(toSample);
  }

  async prune(connectionId: string, before: string): Promise<number> {
    const count = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM workload_samples WHERE connection_id = ? AND window_end < ?',
      [connectionId, before],
    );
    this.db.run('DELETE FROM workload_samples WHERE connection_id = ? AND window_end < ?', [
      connectionId,
      before,
    ]);
    return Number(count?.c ?? 0);
  }
}

function toSample(row: Row): WorkloadSample {
  return {
    id: String(row['id']),
    connectionId: String(row['connection_id']),
    engine: String(row['engine']) as DatabaseEngine,
    fingerprint: String(row['fingerprint']),
    normalizedQuery: String(row['normalized_query']),
    queryType: String(row['query_type']) as QueryType,
    databaseName: String(row['database_name']),
    targetName: String(row['target_name']),
    windowStart: String(row['window_start']),
    windowEnd: String(row['window_end']),
    executionCount: Number(row['execution_count']),
    totalTimeMs: Number(row['total_time_ms']),
    rowsExamined: Number(row['rows_examined']),
    rowsReturned: Number(row['rows_returned']),
    usesIndex: Number(row['uses_index']) === 1,
  };
}
