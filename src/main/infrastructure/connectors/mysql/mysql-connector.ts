/**
 * MySQL 8+ adapter.
 *
 * Collection: polls `performance_schema.events_statements_summary_by_digest`.
 * Because that table reports *cumulative* counters, the checkpoint stores the
 * last-seen counters per digest and we emit only the per-poll delta — so our
 * local history reflects true windowed counts rather than ever-growing totals.
 * Plans come from `EXPLAIN FORMAT=JSON`.
 */

// mysql2 is CommonJS; default-import + destructure for ESM interop.
import mysql from 'mysql2/promise';
import type { Pool, PoolOptions, RowDataPacket } from 'mysql2/promise';
const { createPool } = mysql;
import type {
  IDatabaseConnector,
  RawObservedQuery,
  ExistingIndex,
  ConnectorEvents,
} from '@main/domain/services/database-connector';
import type {
  MySqlConnectionConfig,
  ConnectionStatus,
  ConnectionTestResult,
  CapabilityIssue,
} from '@shared/types/database';
import type { ExecutionPlanNode, IndexAnalysis } from '@shared/types/query';
import { parseMySqlExplain } from './explain-parser';

interface DigestCheckpoint {
  lastSeen: string | null;
  digests: Record<
    string,
    { count: number; timer: number; rowsExam: number; rowsSent: number; noIndex: number; scan: number }
  >;
  prepared?: Record<
    string,
    { count: number; timer: number; rowsExam: number; rowsSent: number; noIndex: number; scan: number }
  >;
}

const PS_TABLE = 'performance_schema.events_statements_summary_by_digest';

export class MySqlConnector implements IDatabaseConnector {
  private pool: Pool | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private readonly handlers = new Map<keyof ConnectorEvents, Set<(...a: never[]) => void>>();

  constructor(
    public readonly config: MySqlConnectionConfig,
    private readonly password: string | null,
  ) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  private poolOptions(): PoolOptions {
    // Build conditionally so undefined keys are omitted (exactOptionalPropertyTypes).
    return {
      host: this.config.host,
      port: this.config.port,
      connectTimeout: 8000,
      ...(this.config.username ? { user: this.config.username } : {}),
      ...(this.password ? { password: this.password } : {}),
      ...(this.config.database ? { database: this.config.database } : {}),
      ...(this.config.tls?.enabled
        ? { ssl: { rejectUnauthorized: this.config.tls.rejectUnauthorized ?? true } }
        : {}),
    };
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const pool = createPool({ ...this.poolOptions(), connectionLimit: 1 });
    try {
      const [verRows] = await pool.query<RowDataPacket[]>('SELECT VERSION() AS v');
      const serverVersion = String(verRows[0]?.['v'] ?? '');
      const issues: CapabilityIssue[] = [];

      const [psRows] = await pool.query<RowDataPacket[]>('SELECT @@performance_schema AS ps');
      if (Number(psRows[0]?.['ps']) !== 1) {
        issues.push({
          code: 'mysql.performance_schema_disabled',
          message: 'performance_schema is disabled on the server',
        });
      }

      try {
        await pool.query(`SELECT 1 FROM ${PS_TABLE} LIMIT 1`);
      } catch {
        issues.push({
          code: 'mysql.no_perfschema_select',
          message: `The account cannot read ${PS_TABLE}`,
        });
      }

      return {
        ok: true,
        latencyMs: Date.now() - started,
        serverVersion,
        monitoringCapable: issues.length === 0,
        ...(issues.length ? { capabilityIssues: issues } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      await pool.end();
    }
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.setStatus('connecting');
    try {
      this.pool = createPool({ ...this.poolOptions(), connectionLimit: 3, waitForConnections: true });
      await this.pool.query('SELECT 1');
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('error');
      this.emit('error', err as Error);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.setStatus('disconnected');
  }

  async explain(
    rawQuery: string,
    databaseName: string,
  ): Promise<{ plan: ExecutionPlanNode; rawPlan: unknown; analysis: IndexAnalysis }> {
    const pool = this.requirePool();
    const conn = await pool.getConnection();
    try {
      if (databaseName) await conn.query(`USE \`${databaseName.replace(/`/g, '')}\``);
      const [rows] = await conn.query<RowDataPacket[]>(`EXPLAIN FORMAT=JSON ${rawQuery}`);
      const json = String(rows[0]?.['EXPLAIN'] ?? rows[0]?.[Object.keys(rows[0] ?? {})[0] ?? '']);
      return parseMySqlExplain(json, 0);
    } finally {
      conn.release();
    }
  }

  async listIndexes(databaseName: string, targetName?: string): Promise<ExistingIndex[]> {
    const pool = this.requirePool();
    const params: (string | undefined)[] = [databaseName];
    let sql = `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION
               FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = ?`;
    if (targetName) {
      sql += ' AND TABLE_NAME = ?';
      params.push(targetName);
    }
    sql += ' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX';
    const [rows] = await pool.query<RowDataPacket[]>(sql, params);

    const byIndex = new Map<string, ExistingIndex>();
    for (const r of rows) {
      const table = String(r['TABLE_NAME']);
      const name = String(r['INDEX_NAME']);
      const key = `${table}.${name}`;
      let idx = byIndex.get(key);
      if (!idx) {
        idx = {
          name,
          databaseName,
          targetName: table,
          fields: [],
          unique: Number(r['NON_UNIQUE']) === 0,
        };
        byIndex.set(key, idx);
      }
      idx.fields.push({
        name: String(r['COLUMN_NAME']),
        direction: r['COLLATION'] === 'D' ? -1 : 1,
      });
    }
    return [...byIndex.values()];
  }

  async collectSince(
    checkpoint: string | null,
  ): Promise<{ queries: RawObservedQuery[]; nextCheckpoint: string }> {
    const pool = this.requirePool();
    const cp: DigestCheckpoint = checkpoint
      ? (JSON.parse(checkpoint) as DigestCheckpoint)
      : { lastSeen: null, digests: {} };
    cp.prepared ??= {};

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT SCHEMA_NAME, DIGEST, DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT,
              MAX_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
              SUM_NO_INDEX_USED, SUM_SELECT_SCAN, LAST_SEEN
       FROM ${PS_TABLE}
       WHERE SCHEMA_NAME IS NOT NULL
         AND SCHEMA_NAME NOT IN ('performance_schema','information_schema','mysql','sys')
         AND DIGEST_TEXT NOT LIKE 'EXPLAIN%'
         AND DIGEST_TEXT NOT LIKE 'SHOW%'
       ORDER BY LAST_SEEN ASC
       LIMIT 1000`,
    );

    const queries: RawObservedQuery[] = [];
    let maxSeen = cp.lastSeen;

    for (const r of rows) {
      const digest = String(r['DIGEST']);
      const count = Number(r['COUNT_STAR']);
      const timer = Number(r['SUM_TIMER_WAIT']);
      const rowsExam = Number(r['SUM_ROWS_EXAMINED']);
      const rowsSent = Number(r['SUM_ROWS_SENT']);
      const noIndex = Number(r['SUM_NO_INDEX_USED']);
      const scan = Number(r['SUM_SELECT_SCAN']);
      const lastSeen = toIso(r['LAST_SEEN']);

      const prev = cp.digests[digest] ?? {
        count: 0,
        timer: 0,
        rowsExam: 0,
        rowsSent: 0,
        noIndex: 0,
        scan: 0,
      };
      const dCount = count - prev.count;
      cp.digests[digest] = { count, timer, rowsExam, rowsSent, noIndex, scan };
      if (!maxSeen || lastSeen > maxSeen) maxSeen = lastSeen;
      if (dCount <= 0) continue; // nothing new for this digest

      const dTimer = Math.max(0, timer - prev.timer);
      const dRowsExam = Math.max(0, rowsExam - prev.rowsExam);
      const dRowsSent = Math.max(0, rowsSent - prev.rowsSent);
      const dNoIndex = Math.max(0, noIndex - prev.noIndex);
      const dScan = Math.max(0, scan - prev.scan);
      const digestText = String(r['DIGEST_TEXT'] ?? '');
      if (isInternalMySqlStatement(digestText)) continue;

      queries.push({
        rawQuery: digestText,
        databaseName: String(r['SCHEMA_NAME']),
        timestamp: lastSeen,
        executionTimeMs: psToMs(dTimer) / dCount,
        metrics: {
          executionCount: dCount,
          rowsExamined: dRowsExam / dCount,
          rowsReturned: dRowsSent / dCount,
          noIndexUsed: dNoIndex > 0,
          fullTableScan: dScan > 0 || dNoIndex > 0,
          maxExecutionTimeMs: psToMs(Number(r['MAX_TIMER_WAIT'])),
        },
      });
    }

    const [preparedRows] = await pool.query<RowDataPacket[]>(
      `SELECT psi.OBJECT_INSTANCE_BEGIN, psi.STATEMENT_ID, psi.SQL_TEXT,
              psi.COUNT_EXECUTE, psi.SUM_TIMER_EXECUTE, psi.MAX_TIMER_EXECUTE,
              psi.SUM_ROWS_EXAMINED, psi.SUM_ROWS_SENT,
              psi.SUM_NO_INDEX_USED, psi.SUM_SELECT_SCAN,
              COALESCE(t.PROCESSLIST_DB, ?) AS SCHEMA_NAME
       FROM performance_schema.prepared_statements_instances psi
       LEFT JOIN performance_schema.threads t ON t.THREAD_ID = psi.OWNER_THREAD_ID
       WHERE COALESCE(t.PROCESSLIST_DB, ?) IS NOT NULL
         AND COALESCE(t.PROCESSLIST_DB, ?) NOT IN ('performance_schema','information_schema','mysql','sys')
       LIMIT 1000`,
      [this.config.database ?? null, this.config.database ?? null, this.config.database ?? null],
    );

    const currentPreparedKeys = new Set<string>();
    for (const r of preparedRows) {
      const sqlText = String(r['SQL_TEXT'] ?? '').trim();
      if (!sqlText || isInternalMySqlStatement(sqlText)) continue;

      const schemaName = String(r['SCHEMA_NAME'] ?? '');
      const key = `${r['OBJECT_INSTANCE_BEGIN']}:${r['STATEMENT_ID']}:${schemaName}:${sqlText}`;
      currentPreparedKeys.add(key);

      const count = Number(r['COUNT_EXECUTE']);
      const timer = Number(r['SUM_TIMER_EXECUTE']);
      const rowsExam = Number(r['SUM_ROWS_EXAMINED']);
      const rowsSent = Number(r['SUM_ROWS_SENT']);
      const noIndex = Number(r['SUM_NO_INDEX_USED']);
      const scan = Number(r['SUM_SELECT_SCAN']);
      const prev = cp.prepared[key] ?? {
        count: 0,
        timer: 0,
        rowsExam: 0,
        rowsSent: 0,
        noIndex: 0,
        scan: 0,
      };

      const dCount = count - prev.count;
      cp.prepared[key] = { count, timer, rowsExam, rowsSent, noIndex, scan };
      if (dCount <= 0) continue;

      const now = new Date().toISOString();
      const dTimer = Math.max(0, timer - prev.timer);
      const dRowsExam = Math.max(0, rowsExam - prev.rowsExam);
      const dRowsSent = Math.max(0, rowsSent - prev.rowsSent);
      const dNoIndex = Math.max(0, noIndex - prev.noIndex);
      const dScan = Math.max(0, scan - prev.scan);

      queries.push({
        rawQuery: sqlText,
        databaseName: schemaName,
        timestamp: now,
        executionTimeMs: psToMs(dTimer) / dCount,
        metrics: {
          executionCount: dCount,
          rowsExamined: dRowsExam / dCount,
          rowsReturned: dRowsSent / dCount,
          noIndexUsed: dNoIndex > 0,
          fullTableScan: dScan > 0 || dNoIndex > 0,
          maxExecutionTimeMs: psToMs(Number(r['MAX_TIMER_EXECUTE'])),
        },
      });
    }
    for (const key of Object.keys(cp.prepared)) {
      if (!currentPreparedKeys.has(key)) delete cp.prepared[key];
    }

    cp.lastSeen = maxSeen;
    return { queries, nextCheckpoint: JSON.stringify(cp) };
  }

  on<E extends keyof ConnectorEvents>(event: E, handler: ConnectorEvents[E]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (...a: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (...a: never[]) => void);
  }

  private emit<E extends keyof ConnectorEvents>(event: E, ...args: Parameters<ConnectorEvents[E]>): void {
    this.handlers.get(event)?.forEach((h) => (h as (...a: unknown[]) => void)(...args));
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit('status', status);
  }

  private requirePool(): Pool {
    if (!this.pool) throw new Error('MySqlConnector is not connected');
    return this.pool;
  }
}

/** performance_schema timers are in picoseconds; 1 ms = 1e9 ps. */
function psToMs(picoseconds: number): number {
  return picoseconds / 1e9;
}

function isInternalMySqlStatement(sql: string): boolean {
  const text = sql.replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const upper = text.toUpperCase();
  if (!upper) return true;

  if (
    upper.startsWith('EXPLAIN ') ||
    upper.startsWith('SHOW ') ||
    upper.startsWith('USE ') ||
    upper.startsWith('SET ')
  ) {
    return true;
  }

  // Query Vitals connection checks, mysql2 handshakes, and other DB metadata probes.
  if (
    upper === 'SELECT ?' ||
    upper === 'SELECT 1' ||
    upper.startsWith('SELECT @@') ||
    upper.includes('VERSION ( )') ||
    upper.includes('VERSION()') ||
    upper.includes('SCHEMA ( )') ||
    upper.includes('SCHEMA()')
  ) {
    return true;
  }

  return [
    'PERFORMANCE_SCHEMA',
    'INFORMATION_SCHEMA',
    'MYSQL.',
    'SYS.',
    'EVENTS_STATEMENTS_SUMMARY_BY_DIGEST',
    'PREPARED_STATEMENTS_INSTANCES',
    'SETUP_CONSUMERS',
    'SETUP_INSTRUMENTS',
    'STATISTICS',
  ].some((token) => upper.includes(token));
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
