import type {
  IQueryHistoryRepository,
  QueryHistoryFilter,
} from '@main/domain/repositories';
import type { IndexAnalysis, QueryRecord } from '@shared/types/query';
import type {
  DashboardMetrics,
  DashboardRanking,
  QueryTimePoint,
  TopQueryEntry,
} from '@shared/types/metrics';
import type { DatabaseEngine } from '@shared/types/database';
import type { Row, SqliteDatabase, SqlValue } from './database';

export class SqliteQueryHistoryRepository implements IQueryHistoryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async upsert(record: QueryRecord): Promise<void> {
    this.upsertSync(record);
  }

  async bulkUpsert(records: QueryRecord[]): Promise<void> {
    this.db.transaction(() => records.forEach((r) => this.upsertSync(r)));
  }

  private upsertSync(r: QueryRecord): void {
    const count = r.executionCount ?? 1;
    const avg = r.avgExecutionTimeMs ?? r.executionTimeMs;
    const max = r.maxExecutionTimeMs ?? r.executionTimeMs;
    this.db.run(
      `INSERT INTO query_history
        (id, connection_id, engine, source, raw_query, normalized_query,
         fingerprint, query_type, database_name, target_name, related_targets,
         execution_time_ms, timestamp, execution_count,
         avg_execution_time_ms, max_execution_time_ms, analysis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(connection_id, fingerprint) DO UPDATE SET
         raw_query = excluded.raw_query,
         timestamp = excluded.timestamp,
         execution_time_ms = excluded.execution_time_ms,
         avg_execution_time_ms =
           (avg_execution_time_ms * execution_count
             + excluded.avg_execution_time_ms * excluded.execution_count)
           / (execution_count + excluded.execution_count),
         max_execution_time_ms = MAX(max_execution_time_ms, excluded.max_execution_time_ms),
         execution_count = execution_count + excluded.execution_count,
         analysis = excluded.analysis`,
      [
        r.id,
        r.connectionId,
        r.engine,
        r.source,
        r.rawQuery,
        r.normalizedQuery,
        r.fingerprint,
        r.queryType,
        r.databaseName,
        r.targetName,
        r.relatedTargets ? JSON.stringify(r.relatedTargets) : null,
        r.executionTimeMs,
        r.timestamp,
        count,
        avg,
        max,
        r.analysis ? JSON.stringify(r.analysis) : null,
      ],
    );
  }

  async get(id: string): Promise<QueryRecord | null> {
    const row = this.db.get('SELECT * FROM query_history WHERE id = ?', [id]);
    return row ? toRecord(row) : null;
  }

  async query(filter: QueryHistoryFilter): Promise<QueryRecord[]> {
    const where: string[] = ['connection_id = ?'];
    const params: SqlValue[] = [filter.connectionId];
    if (filter.from) {
      where.push('timestamp >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('timestamp <= ?');
      params.push(filter.to);
    }
    if (filter.onlyFullScans) where.push("json_extract(analysis,'$.fullTableScan') = 1");
    if (filter.onlyNonIndexed) where.push("json_extract(analysis,'$.usesIndex') = 0");
    if (filter.minExecutionTimeMs != null) {
      where.push('avg_execution_time_ms >= ?');
      params.push(filter.minExecutionTimeMs);
    }
    if (filter.search) {
      where.push('normalized_query LIKE ?');
      params.push(`%${filter.search}%`);
    }
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    params.push(limit, offset);
    const rows = this.db.all(
      `SELECT * FROM query_history WHERE ${where.join(' AND ')}
       ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map(toRecord);
  }

  async ranking(
    connectionId: string,
    ranking: DashboardRanking,
    limit: number,
  ): Promise<TopQueryEntry[]> {
    const order: Record<DashboardRanking, string> = {
      slowest: 'avg_execution_time_ms DESC',
      'most-executed': 'execution_count DESC',
      'full-scans': 'execution_count DESC',
      'poor-selectivity': "json_extract(analysis,'$.selectivity') ASC",
    };
    const extraWhere =
      ranking === 'full-scans'
        ? "AND json_extract(analysis,'$.fullTableScan') = 1"
        : ranking === 'poor-selectivity'
          ? 'AND analysis IS NOT NULL'
          : '';
    const rows = this.db.all(
      `SELECT fingerprint, normalized_query, target_name, execution_count,
              avg_execution_time_ms, max_execution_time_ms,
              COALESCE(json_extract(analysis,'$.fullTableScan'),0) AS full_scan,
              COALESCE(json_extract(analysis,'$.selectivity'),1) AS selectivity,
              COALESCE(json_extract(analysis,'$.performanceScore'),0) AS score
       FROM query_history
       WHERE connection_id = ? ${extraWhere}
       ORDER BY ${order[ranking]} LIMIT ?`,
      [connectionId, limit],
    );
    return rows.map((row) => ({
      fingerprint: String(row['fingerprint']),
      normalizedQuery: String(row['normalized_query']),
      targetName: String(row['target_name']),
      executionCount: Number(row['execution_count']),
      avgExecutionTimeMs: Number(row['avg_execution_time_ms']),
      maxExecutionTimeMs: Number(row['max_execution_time_ms']),
      fullScan: Number(row['full_scan']) === 1,
      selectivity: Number(row['selectivity']),
      performanceScore: Number(row['score']),
    }));
  }

  async timeSeries(
    connectionId: string,
    from: string,
    to: string,
    bucketMs: number,
  ): Promise<QueryTimePoint[]> {
    const bucketSec = Math.max(1, Math.round(bucketMs / 1000));
    const rows = this.db.all(
      `SELECT
         CAST(strftime('%s', timestamp) / ? AS INTEGER) * ? AS bucket,
         AVG(avg_execution_time_ms) AS avg_ms,
         SUM(execution_count) AS cnt
       FROM query_history
       WHERE connection_id = ? AND timestamp >= ? AND timestamp <= ?
       GROUP BY bucket ORDER BY bucket`,
      [bucketSec, bucketSec, connectionId, from, to],
    );
    return rows.map((row) => ({
      timestamp: new Date(Number(row['bucket']) * 1000).toISOString(),
      avgMs: Number(row['avg_ms']),
      count: Number(row['cnt']),
    }));
  }

  async metrics(connectionId: string, from: string, to: string): Promise<DashboardMetrics> {
    const row = this.db.get(
      `SELECT
         COALESCE(SUM(execution_count),0) AS total,
         COALESCE(SUM(CASE WHEN json_extract(analysis,'$.usesIndex')=1 THEN execution_count ELSE 0 END),0) AS indexed,
         COALESCE(SUM(CASE WHEN json_extract(analysis,'$.usesIndex')=0 THEN execution_count ELSE 0 END),0) AS non_indexed,
         COALESCE(SUM(CASE WHEN avg_execution_time_ms >=
           COALESCE((SELECT slow_query_threshold_ms FROM settings WHERE connection_id = ?),100)
           THEN execution_count ELSE 0 END),0) AS slow,
         COALESCE(SUM(avg_execution_time_ms*execution_count)/NULLIF(SUM(execution_count),0),0) AS avg_ms
       FROM query_history
       WHERE connection_id = ? AND timestamp >= ? AND timestamp <= ?`,
      [connectionId, connectionId, from, to],
    );
    const total = Number(row?.['total'] ?? 0);
    const indexed = Number(row?.['indexed'] ?? 0);
    return {
      connectionId,
      windowFrom: from,
      windowTo: to,
      totalQueries: total,
      indexedQueries: indexed,
      nonIndexedQueries: Number(row?.['non_indexed'] ?? 0),
      slowQueries: Number(row?.['slow'] ?? 0),
      averageQueryTimeMs: Number(row?.['avg_ms'] ?? 0),
      indexCoveragePct: total > 0 ? Math.round((indexed / total) * 100) : 0,
    };
  }

  async prune(connectionId: string, retentionLimit: number): Promise<number> {
    const before = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM query_history WHERE connection_id = ?',
      [connectionId],
    );
    this.db.run(
      `DELETE FROM query_history WHERE id IN (
         SELECT id FROM query_history WHERE connection_id = ?
         ORDER BY timestamp DESC LIMIT -1 OFFSET ?
       )`,
      [connectionId, retentionLimit],
    );
    const after = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM query_history WHERE connection_id = ?',
      [connectionId],
    );
    return Number(before?.c ?? 0) - Number(after?.c ?? 0);
  }
}

function toRecord(row: Row): QueryRecord {
  const analysis = row['analysis']
    ? (JSON.parse(String(row['analysis'])) as IndexAnalysis)
    : undefined;
  const related = row['related_targets']
    ? (JSON.parse(String(row['related_targets'])) as string[])
    : undefined;
  return {
    id: String(row['id']),
    connectionId: String(row['connection_id']),
    engine: String(row['engine']) as DatabaseEngine,
    source: String(row['source']) as QueryRecord['source'],
    rawQuery: String(row['raw_query']),
    normalizedQuery: String(row['normalized_query']),
    fingerprint: String(row['fingerprint']),
    queryType: String(row['query_type']) as QueryRecord['queryType'],
    databaseName: String(row['database_name']),
    targetName: String(row['target_name']),
    executionTimeMs: Number(row['execution_time_ms']),
    timestamp: String(row['timestamp']),
    executionCount: Number(row['execution_count']),
    avgExecutionTimeMs: Number(row['avg_execution_time_ms']),
    maxExecutionTimeMs: Number(row['max_execution_time_ms']),
    ...(related ? { relatedTargets: related } : {}),
    ...(analysis ? { analysis } : {}),
  };
}
