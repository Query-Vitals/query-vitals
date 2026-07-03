/**
 * PostgreSQL 13+ adapter.
 *
 * Collection: polls `pg_stat_statements`. Like MySQL digests, the view reports
 * *cumulative* counters, so the checkpoint stores last-seen counters per
 * queryid and we emit only the per-poll delta. Unlike performance_schema,
 * pg_stat_statements carries no index-usage signal, so the connector derives
 * one deterministically by planning each new statement once (`EXPLAIN
 * (GENERIC_PLAN)` on PG 16+, plain `EXPLAIN` for literal statements) and
 * caches the verdict per queryid in the checkpoint.
 *
 * A PostgreSQL session is scoped to one database, so collection is filtered to
 * `current_database()` — statements from other databases in the cluster could
 * not be EXPLAINed or indexed from this connection anyway.
 */

// pg is CommonJS; default-import + destructure for ESM interop.
import pg from 'pg';
import type { Pool as PgPool, PoolConfig } from 'pg';
const { Pool } = pg;
import type {
  IDatabaseConnector,
  RawObservedQuery,
  ExistingIndex,
  ConnectorEvents,
  ExplainOptions,
} from '@main/domain/services/database-connector';
import type {
  PostgresConnectionConfig,
  ConnectionStatus,
  ConnectionTestResult,
  CapabilityIssue,
} from '@shared/types/database';
import type { ExecutionPlanNode, IndexAnalysis } from '@shared/types/query';
import { parsePostgresExplain } from './pg-explain-parser';

/** Plan-derived index verdict cached per queryid (null = EXPLAIN failed). */
interface PlanVerdict {
  usesIndex: boolean;
  seqScan: boolean;
  rowsExamined: number;
}

interface StatementCounters {
  calls: number;
  timeMs: number;
  rows: number;
}

interface PgCheckpoint {
  statements: Record<string, StatementCounters>;
  verdicts: Record<string, PlanVerdict | null>;
}

export class PostgresConnector implements IDatabaseConnector {
  private pool: PgPool | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private serverVersionNum = 0;
  private readonly handlers = new Map<keyof ConnectorEvents, Set<(...a: never[]) => void>>();

  constructor(
    public readonly config: PostgresConnectionConfig,
    private readonly password: string | null,
  ) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  private poolConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
    // Build conditionally so undefined keys are omitted (exactOptionalPropertyTypes).
    return {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database?.trim() || 'postgres',
      connectionTimeoutMillis: 8000,
      ...(this.config.username ? { user: this.config.username } : {}),
      ...(this.password ? { password: this.password } : {}),
      ...(this.config.tls?.enabled
        ? { ssl: { rejectUnauthorized: this.config.tls.rejectUnauthorized ?? true } }
        : {}),
      ...overrides,
    };
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const pool = new Pool(this.poolConfig({ max: 1 }));
    try {
      const ver = await pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
      const serverVersion = String(ver.rows[0]?.v ?? '');
      const issues: CapabilityIssue[] = [];

      const preload = await pool.query<{ setting: string }>(
        `SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'`,
      );
      const loaded = (preload.rows[0]?.setting ?? '').includes('pg_stat_statements');
      if (!loaded) {
        issues.push({
          code: 'postgres.pg_stat_statements_not_loaded',
          message: 'pg_stat_statements is not in shared_preload_libraries',
        });
      }

      const ext = await pool.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`,
      );
      if (loaded && ext.rowCount === 0) {
        issues.push({
          code: 'postgres.pg_stat_statements_not_created',
          message: 'The pg_stat_statements extension has not been created in this database',
        });
      }

      if (loaded && (ext.rowCount ?? 0) > 0) {
        try {
          // Without pg_read_all_stats, other roles' statements come back with
          // their text masked — monitoring would silently miss most traffic.
          const masked = await pool.query(
            `SELECT 1 FROM pg_stat_statements WHERE query = '<insufficient privilege>' LIMIT 1`,
          );
          if ((masked.rowCount ?? 0) > 0) {
            issues.push({
              code: 'postgres.no_stats_access',
              message: "The account cannot read other roles' statements in pg_stat_statements",
            });
          }
        } catch {
          issues.push({
            code: 'postgres.no_stats_access',
            message: 'The account cannot read pg_stat_statements',
          });
        }
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
      this.pool = new Pool(this.poolConfig({ max: 3 }));
      const res = await this.pool.query<{ n: string }>(
        `SELECT current_setting('server_version_num') AS n`,
      );
      this.serverVersionNum = Number(res.rows[0]?.n ?? 0);
      this.setStatus('connected');
    } catch (err) {
      await this.pool?.end().catch(() => undefined);
      this.pool = null;
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
    _databaseName: string,
    opts?: ExplainOptions,
  ): Promise<{ plan: ExecutionPlanNode; rawPlan: unknown; analysis: IndexAnalysis }> {
    // The session is bound to config.database; databaseName is informational.
    const pool = this.requirePool();
    const json = await this.runExplain(pool, rawQuery, opts?.analyze === true);
    return parsePostgresExplain(json, 0);
  }

  /**
   * Run EXPLAIN and return the plan JSON as a string. Statements normalized by
   * pg_stat_statements carry `$n` placeholders and are not directly runnable;
   * PG 16+ plans them via GENERIC_PLAN (mutually exclusive with ANALYZE).
   */
  private async runExplain(pool: PgPool, rawQuery: string, analyze: boolean): Promise<string> {
    const hasParams = /\$\d+\b/.test(rawQuery);
    if (hasParams && analyze) {
      throw new Error(
        'EXPLAIN ANALYZE needs a runnable statement; this one has $n placeholders. Replace them with real values first.',
      );
    }
    if (hasParams && this.serverVersionNum < 160000) {
      throw new Error(
        'Planning a parameterized ($n) statement requires PostgreSQL 16+ (EXPLAIN GENERIC_PLAN). Paste the query with real values instead.',
      );
    }
    const options = analyze
      ? 'ANALYZE, BUFFERS, FORMAT JSON'
      : hasParams
        ? 'GENERIC_PLAN, FORMAT JSON'
        : 'FORMAT JSON';
    const res = await pool.query(`EXPLAIN (${options}) ${rawQuery}`);
    const value: unknown = (res.rows[0] as Record<string, unknown>)?.['QUERY PLAN'];
    // The driver may hand back parsed JSON or text depending on column type.
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  async listIndexes(databaseName: string, targetName?: string): Promise<ExistingIndex[]> {
    const pool = this.requirePool();
    const params: string[] = [];
    let filter = '';
    if (targetName) {
      params.push(targetName);
      filter = 'AND t.relname = $1';
    }
    // One row per index column, in index order. Expression columns have
    // attnum 0 and no pg_attribute row; pg_get_indexdef renders their text
    // (e.g. "lower(email)"). indoption bit 0 set means DESC.
    const res = await pool.query(
      `SELECT t.relname AS table_name,
              i.relname AS index_name,
              ix.indisunique AS is_unique,
              ix.indisprimary AS is_primary,
              am.amname AS method,
              s.idx_scan AS idx_scan,
              ord.n AS seq,
              COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, ord.n::int, true)) AS column_name,
              (ix.indoption[ord.n - 1] & 1) = 1 AS is_desc
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
       CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, n)
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ord.attnum AND ord.attnum <> 0
       WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ${filter}
       ORDER BY t.relname, i.relname, ord.n`,
      params,
    );

    const byIndex = new Map<string, ExistingIndex>();
    for (const r of res.rows as Record<string, unknown>[]) {
      const table = String(r['table_name']);
      const name = String(r['index_name']);
      const key = `${table}.${name}`;
      let idx = byIndex.get(key);
      if (!idx) {
        idx = {
          name,
          databaseName,
          targetName: table,
          fields: [],
          unique: Boolean(r['is_unique']),
          ...(r['is_primary'] === true ? { primary: true } : {}),
          method: String(r['method']),
          // idx_scan is how many times the index was used since stats reset —
          // the same role $indexStats plays for Mongo unused-index detection.
          ...(r['idx_scan'] != null ? { accessCount: Number(r['idx_scan']) } : {}),
        };
        byIndex.set(key, idx);
      }
      idx.fields.push({
        name: String(r['column_name']),
        direction: r['is_desc'] === true ? -1 : 1,
      });
    }
    return [...byIndex.values()];
  }

  async collectSince(
    checkpoint: string | null,
  ): Promise<{ queries: RawObservedQuery[]; nextCheckpoint: string }> {
    const pool = this.requirePool();
    const cp: PgCheckpoint = checkpoint
      ? (JSON.parse(checkpoint) as PgCheckpoint)
      : { statements: {}, verdicts: {} };
    cp.verdicts ??= {};

    const rows = await this.queryStatements(pool);
    const now = new Date().toISOString();
    const queries: RawObservedQuery[] = [];
    const liveIds = new Set<string>();
    let explainsThisPoll = 0;

    for (const r of rows) {
      liveIds.add(r.queryId);
      const prev = cp.statements[r.queryId] ?? { calls: 0, timeMs: 0, rows: 0 };
      // A counter that went backwards means pg_stat_statements was reset —
      // rebase on zero so the poll after a reset is not silently dropped.
      const base = r.calls >= prev.calls ? prev : { calls: 0, timeMs: 0, rows: 0 };
      cp.statements[r.queryId] = { calls: r.calls, timeMs: r.timeMs, rows: r.rows };

      const dCalls = r.calls - base.calls;
      if (dCalls <= 0) continue;
      if (isInternalPostgresStatement(r.query)) continue;

      const dTimeMs = Math.max(0, r.timeMs - base.timeMs);
      const dRows = Math.max(0, r.rows - base.rows);
      const rowsReturned = dRows / dCalls;

      // Derive the index verdict once per digest, hottest statements first
      // (rows are ordered by calls DESC). The per-poll budget keeps the first
      // poll against a busy server from issuing hundreds of EXPLAINs at once —
      // digests past the budget stay unresolved and are planned on later polls.
      if (!(r.queryId in cp.verdicts)) {
        if (!isPlannable(r.query)) {
          cp.verdicts[r.queryId] = null;
        } else if (explainsThisPoll < EXPLAIN_BUDGET_PER_POLL) {
          explainsThisPoll += 1;
          cp.verdicts[r.queryId] = await this.planVerdict(pool, r.query);
        }
      }
      const verdict = cp.verdicts[r.queryId] ?? null;

      queries.push({
        rawQuery: r.query,
        databaseName: r.database,
        timestamp: now,
        executionTimeMs: dTimeMs / dCalls,
        metrics: {
          executionCount: dCalls,
          // The view has no examined-rows counter; the planner estimate stands
          // in. When even that is unavailable the query is treated as fully
          // selective rather than inventing a scan.
          rowsExamined: verdict ? Math.max(verdict.rowsExamined, rowsReturned) : rowsReturned,
          rowsReturned,
          noIndexUsed: verdict ? !verdict.usesIndex : false,
          fullTableScan: verdict ? verdict.seqScan : false,
          maxExecutionTimeMs: r.maxTimeMs,
        },
      });
    }

    // Drop checkpoint entries for statements evicted from the view.
    for (const id of Object.keys(cp.statements)) {
      if (!liveIds.has(id)) {
        delete cp.statements[id];
        delete cp.verdicts[id];
      }
    }

    return { queries, nextCheckpoint: JSON.stringify(cp) };
  }

  /** Read pg_stat_statements, tolerating the pre-1.8 column names. */
  private async queryStatements(pool: PgPool): Promise<
    Array<{
      queryId: string;
      query: string;
      database: string;
      calls: number;
      timeMs: number;
      maxTimeMs: number;
      rows: number;
    }>
  > {
    const select = (total: string, max: string): string =>
      `SELECT s.queryid::text AS query_id, s.query, s.calls,
              s.${total} AS total_time_ms, s.${max} AS max_time_ms, s.rows,
              current_database() AS database_name
       FROM pg_stat_statements s
       JOIN pg_database d ON d.oid = s.dbid
       WHERE d.datname = current_database()
         AND s.queryid IS NOT NULL
       ORDER BY s.calls DESC
       LIMIT 1000`;

    let res;
    try {
      res = await pool.query(select('total_exec_time', 'max_exec_time'));
    } catch {
      // pg_stat_statements < 1.8 (PostgreSQL < 13) named the columns without _exec.
      res = await pool.query(select('total_time', 'max_time'));
    }
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      queryId: String(r['query_id']),
      query: String(r['query'] ?? ''),
      database: String(r['database_name']),
      calls: Number(r['calls']),
      timeMs: Number(r['total_time_ms']),
      maxTimeMs: Number(r['max_time_ms']),
      rows: Number(r['rows']),
    }));
  }

  /**
   * Plan a collected statement once to learn whether it uses an index.
   * Returns null (cached) when the statement cannot be planned — missing
   * GENERIC_PLAN support, dropped relations, insufficient privileges, etc.
   */
  private async planVerdict(pool: PgPool, query: string): Promise<PlanVerdict | null> {
    try {
      const json = await this.runExplain(pool, query, false);
      const { analysis } = parsePostgresExplain(json, 0);
      return {
        usesIndex: analysis.usesIndex,
        seqScan: analysis.fullTableScan,
        rowsExamined: analysis.rowsExamined,
      };
    } catch {
      return null;
    }
  }

  on<E extends keyof ConnectorEvents>(event: E, handler: ConnectorEvents[E]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (...a: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (...a: never[]) => void);
  }

  private emit<E extends keyof ConnectorEvents>(
    event: E,
    ...args: Parameters<ConnectorEvents[E]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as (...a: unknown[]) => void)(...args));
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit('status', status);
  }

  private requirePool(): PgPool {
    if (!this.pool) throw new Error('PostgresConnector is not connected');
    return this.pool;
  }
}

/** How many uncached digests get an EXPLAIN verdict in a single poll tick. */
const EXPLAIN_BUDGET_PER_POLL = 100;

/** Only DML/CTE statements can be planned; utility statements never can. */
function isPlannable(query: string): boolean {
  return /^\s*(select|insert|update|delete|with)\b/i.test(query);
}

/** Statements produced by Query Vitals itself or by DB tooling, not user load. */
function isInternalPostgresStatement(sql: string): boolean {
  const text = sql.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  const upper = text.toUpperCase();
  if (!upper) return true;
  if (upper === '<INSUFFICIENT PRIVILEGE>') return true;

  if (
    upper.startsWith('EXPLAIN ') ||
    upper.startsWith('SHOW ') ||
    upper.startsWith('SET ') ||
    upper.startsWith('BEGIN') ||
    upper.startsWith('COMMIT') ||
    upper.startsWith('ROLLBACK') ||
    upper.startsWith('PREPARE ') ||
    upper.startsWith('DEALLOCATE ')
  ) {
    return true;
  }

  return [
    'PG_STAT_STATEMENTS',
    'PG_CATALOG.',
    'PG_SETTINGS',
    'PG_EXTENSION',
    'PG_INDEX',
    'PG_NAMESPACE',
    'PG_STAT_USER_INDEXES',
    'PG_DATABASE',
    'INFORMATION_SCHEMA',
    'CURRENT_DATABASE ( )',
    'CURRENT_DATABASE()',
  ].some((token) => upper.includes(token));
}
