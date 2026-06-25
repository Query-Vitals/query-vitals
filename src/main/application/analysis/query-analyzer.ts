/**
 * Default IQueryAnalyzer implementation.
 * - Normalization:
 *     MySQL — light literal-stripping (digest text is already normalized) +
 *       table/type extraction via node-sql-parser with a regex fallback.
 *     MongoDB — the command document is canonicalized: field names and
 *       operators are kept, literal values become "?", scalar arrays collapse
 *       to one placeholder, so a thousand runs share one fingerprint.
 * - Analysis: derived from collector metrics when available, otherwise EXPLAIN.
 *   The metrics path is engine-aware so Mongo reports a collection scan and
 *   COLLSCAN/IXSCAN stage labels rather than MySQL's ALL/index vocabulary.
 */

import { randomUUID, createHash } from 'node:crypto';
// node-sql-parser is CommonJS; default-import + destructure for ESM interop.
import NodeSqlParser from 'node-sql-parser';
const { Parser } = NodeSqlParser;
type Parser = InstanceType<typeof Parser>;
import type {
  IQueryAnalyzer,
  NormalizedStatement,
  AnalyzeOptions,
} from '@main/domain/services/query-analyzer';
import type { RawObservedQuery, IDatabaseConnector } from '@main/domain/services/database-connector';
import type { DatabaseEngine } from '@shared/types/database';
import type { IndexAnalysis, QueryRecord, QueryType } from '@shared/types/query';
import { computeScore, computeScoreBreakdown } from '@main/domain/value-objects/scoring';

const DEFAULT_SLOW_MS = 100;

export class QueryAnalyzer implements IQueryAnalyzer {
  private readonly parser = new Parser();

  normalize(raw: RawObservedQuery, engine: DatabaseEngine): NormalizedStatement {
    return engine === 'mongodb' ? this.normalizeMongo(raw) : this.normalizeSqlStatement(raw);
  }

  private normalizeSqlStatement(raw: RawObservedQuery): NormalizedStatement {
    const text = raw.rawQuery.trim();
    const normalizedQuery = normalizeSql(text);
    const queryType = detectType(text);
    const { target, related } = extractTables(text, this.parser);
    return {
      normalizedQuery,
      fingerprint: fingerprintOf(raw.databaseName, normalizedQuery),
      queryType,
      databaseName: raw.databaseName,
      targetName: raw.targetName ?? target,
      relatedTargets: related,
    };
  }

  private normalizeMongo(raw: RawObservedQuery): NormalizedStatement {
    let command: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.rawQuery);
      command =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      // Not JSON — treat the text as opaque rather than throwing.
      const normalizedQuery = raw.rawQuery.replace(/\s+/g, ' ').trim();
      return {
        normalizedQuery,
        fingerprint: fingerprintOf(raw.databaseName, normalizedQuery),
        queryType: 'other',
        databaseName: raw.databaseName,
        targetName: raw.targetName ?? 'unknown',
        relatedTargets: [],
      };
    }

    const verb = MONGO_VERBS.find((v) => v in command);
    const queryType = mongoQueryType(verb);
    // The collection is the value of the verb key, e.g. find: "users" → "users".
    const collection =
      verb && typeof command[verb] === 'string' ? (command[verb] as string) : undefined;
    const normalizedQuery = JSON.stringify(canonicalizeMongo(command));

    return {
      normalizedQuery,
      fingerprint: fingerprintOf(raw.databaseName, normalizedQuery),
      queryType,
      databaseName: raw.databaseName,
      targetName: raw.targetName ?? collection ?? 'unknown',
      relatedTargets: mongoLookupTargets(command),
    };
  }

  async analyze(
    raw: RawObservedQuery,
    connector: IDatabaseConnector,
    opts?: AnalyzeOptions,
  ): Promise<IndexAnalysis> {
    const slowThresholdMs = opts?.slowThresholdMs ?? DEFAULT_SLOW_MS;

    if (raw.metrics) {
      return this.analyzeFromMetrics(raw, slowThresholdMs, connector.config.engine);
    }

    const { analysis } = await connector.explain(raw.rawQuery, raw.databaseName);
    // Re-score with the caller's threshold and the observed execution time.
    const scoreInput = {
      usesIndex: analysis.usesIndex,
      fullScan: analysis.fullTableScan,
      rowsExamined: analysis.rowsExamined,
      rowsReturned: analysis.rowsReturned,
      executionTimeMs: raw.executionTimeMs,
      slowThresholdMs,
    };
    return {
      ...analysis,
      performanceScore: computeScore(scoreInput),
      scoreBreakdown: computeScoreBreakdown(scoreInput),
    };
  }

  async toRecord(
    raw: RawObservedQuery,
    connector: IDatabaseConnector,
    source: QueryRecord['source'],
    opts?: AnalyzeOptions,
  ): Promise<QueryRecord> {
    const norm = this.normalize(raw, connector.config.engine);
    const analysis = await this.analyze(raw, connector, opts);
    return {
      id: randomUUID(),
      connectionId: connector.config.id,
      engine: connector.config.engine,
      source,
      rawQuery: raw.rawQuery,
      normalizedQuery: norm.normalizedQuery,
      fingerprint: norm.fingerprint,
      queryType: norm.queryType,
      databaseName: norm.databaseName,
      targetName: norm.targetName,
      executionTimeMs: raw.executionTimeMs,
      timestamp: raw.timestamp,
      ...(norm.relatedTargets.length ? { relatedTargets: norm.relatedTargets } : {}),
      ...(raw.metrics
        ? {
            executionCount: raw.metrics.executionCount,
            avgExecutionTimeMs: raw.executionTimeMs,
            maxExecutionTimeMs: raw.metrics.maxExecutionTimeMs ?? raw.executionTimeMs,
          }
        : {}),
      analysis,
    };
  }

  private analyzeFromMetrics(
    raw: RawObservedQuery,
    slowThresholdMs: number,
    engine: DatabaseEngine,
  ): IndexAnalysis {
    const m = raw.metrics!;
    const usesIndex = !m.noIndexUsed;
    const selectivity = m.rowsExamined > 0 ? Math.min(1, m.rowsReturned / m.rowsExamined) : 1;
    // `m.fullTableScan` carries "a scan happened" for both engines; the score's
    // scanPenalty is the same, only the surfaced vocabulary differs.
    const scanned = m.fullTableScan;
    const isMongo = engine === 'mongodb';

    const scoreInput = {
      usesIndex,
      fullScan: scanned,
      rowsExamined: m.rowsExamined,
      rowsReturned: m.rowsReturned,
      executionTimeMs: raw.executionTimeMs,
      slowThresholdMs,
    };

    const source = isMongo ? 'profiler' : 'performance_schema';
    const stage = isMongo ? (scanned ? 'COLLSCAN' : 'IXSCAN') : scanned ? 'ALL' : 'index';
    const detail = scanned
      ? `No index used (${source}). Run explain for the full plan.`
      : `Index used (${source}). Run explain for the full plan.`;

    return {
      usesIndex,
      fullTableScan: isMongo ? false : scanned,
      collectionScan: isMongo ? scanned : false,
      indexesUsed: [],
      rowsExamined: m.rowsExamined,
      rowsReturned: m.rowsReturned,
      selectivity,
      executionPlan: {
        stage,
        ...(raw.targetName ? { target: raw.targetName } : {}),
        rowsExamined: m.rowsExamined,
        rowsReturned: m.rowsReturned,
        detail,
      },
      rawPlan: null,
      performanceScore: computeScore(scoreInput),
      scoreBreakdown: computeScoreBreakdown(scoreInput),
    };
  }
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.)*'/g, '?') // single-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '?') // double-quoted strings
    .replace(/\b\d+(?:\.\d+)?\b/g, '?') // numbers
    .replace(/\s+/g, ' ')
    .trim();
}

function detectType(sql: string): QueryType {
  const w = sql.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  switch (w) {
    case 'select':
      return 'select';
    case 'insert':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      return 'other';
  }
}

function extractTables(sql: string, parser: Parser): { target: string; related: string[] } {
  try {
    const result = parser.tableList(sql, { database: 'MySQL' });
    // tableList returns entries like "select::db::table".
    const names = result.map((t) => t.split('::').pop() ?? '').filter(Boolean);
    if (names.length) return { target: names[0] ?? 'unknown', related: names.slice(1) };
  } catch {
    /* fall through to regex */
  }
  const m = sql.match(/\b(?:from|into|update|join)\s+`?([a-zA-Z0-9_]+)`?/i);
  return { target: m?.[1] ?? 'unknown', related: [] };
}

function fingerprintOf(databaseName: string, normalizedQuery: string): string {
  return createHash('sha1').update(`${databaseName}::${normalizedQuery}`).digest('hex');
}

/* ---------- MongoDB normalization ---------- */

/** Command verbs whose value names the target collection. */
const MONGO_VERBS = [
  'find',
  'aggregate',
  'count',
  'distinct',
  'findAndModify',
  'update',
  'delete',
  'insert',
] as const;

function mongoQueryType(verb: string | undefined): QueryType {
  switch (verb) {
    case 'find':
      return 'find';
    case 'aggregate':
      return 'aggregate';
    case 'count':
      return 'count';
    case 'update':
    case 'findAndModify':
      return 'update';
    case 'delete':
      return 'delete';
    case 'insert':
      return 'insert';
    default:
      return 'other';
  }
}

/**
 * Canonicalize a command document. Top-level verb values (collection names)
 * are kept so queries on different collections stay distinct; every other
 * literal is replaced with "?". Object keys (field names and `$`-operators) are
 * preserved and sorted for a stable, value-independent fingerprint.
 */
function canonicalizeMongo(command: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(command).sort()) {
    const value = command[key];
    out[key] =
      (MONGO_VERBS as readonly string[]).includes(key) && typeof value === 'string'
        ? value
        : canonicalizeValue(value);
  }
  return out;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    // Arrays of objects (e.g. aggregation pipelines) keep their structure;
    // scalar arrays (e.g. `$in` lists) collapse to one placeholder.
    const allObjects = value.every((el) => el !== null && typeof el === 'object');
    return allObjects ? value.map(canonicalizeValue) : ['?'];
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalizeValue(obj[key]);
    return out;
  }
  return '?';
}

/** Collect collections referenced by `$lookup` / `$graphLookup` pipeline stages. */
function mongoLookupTargets(command: Record<string, unknown>): string[] {
  const pipeline = command['pipeline'];
  if (!Array.isArray(pipeline)) return [];
  const targets = new Set<string>();
  for (const stage of pipeline) {
    if (!stage || typeof stage !== 'object') continue;
    const s = stage as Record<string, unknown>;
    for (const op of ['$lookup', '$graphLookup'] as const) {
      const spec = s[op];
      if (spec && typeof spec === 'object') {
        const from = (spec as Record<string, unknown>)['from'];
        if (typeof from === 'string') targets.add(from);
      }
    }
  }
  return [...targets];
}
