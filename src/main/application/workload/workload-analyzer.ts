/**
 * Default IWorkloadAnalyzer.
 *
 * Deterministic N+1 detection. Per-window samples are grouped by fingerprint;
 * samples of the same fingerprint that fall within `burstGapMs` of each other
 * merge into a single burst. A burst is flagged when:
 *   1. the normalized query is a repeated *point lookup* — a SELECT/find whose
 *      predicate is equality-only on one or two key-shaped columns, the shape
 *      that becomes `IN (...)` / `$in` / a join when batched; and
 *   2. it ran at least `minExecutions` times in the window.
 *
 * Insights are scored by *total* cost (cumulative time, execution count, rows
 * examined) rather than per-query latency, because each individual execution
 * may look perfectly healthy — the cost is in the repetition.
 *
 * The analyzer is pure: same samples + options → same insights.
 */

// node-sql-parser is CommonJS; default-import + destructure for ESM interop.
import NodeSqlParser from 'node-sql-parser';
const { Parser } = NodeSqlParser;
type Parser = InstanceType<typeof Parser>;

import type {
  IWorkloadAnalyzer,
  WorkloadAnalysisInput,
} from '@main/domain/services/workload-analyzer';
import type {
  WorkloadInsight,
  WorkloadSample,
  WorkloadAnalysisOptions,
} from '@shared/types/workload';
import { DEFAULT_WORKLOAD_OPTIONS } from '@shared/types/workload';
import type { RecommendationSeverity } from '@shared/types/recommendation';
import type { DatabaseEngine } from '@shared/types/database';

/** A point-lookup shape detected on a query, with the equality columns. */
interface LookupShape {
  fields: string[];
}

/** A run of same-fingerprint samples that cluster within the burst gap. */
interface Burst {
  samples: WorkloadSample[];
  startMs: number;
  endMs: number;
}

export class WorkloadAnalyzer implements IWorkloadAnalyzer {
  private readonly parser = new Parser();

  analyze(input: WorkloadAnalysisInput): WorkloadInsight[] {
    const opts: WorkloadAnalysisOptions = { ...DEFAULT_WORKLOAD_OPTIONS, ...input.options };
    const byFingerprint = groupBy(input.samples, (s) => s.fingerprint);

    const insights: WorkloadInsight[] = [];
    for (const samples of byFingerprint.values()) {
      const head = samples[0];
      if (!head) continue;
      const shape = this.detectPointLookup(head);
      if (!shape) continue;

      for (const burst of buildBursts(samples, opts.burstGapMs)) {
        const executionCount = sum(burst.samples, (s) => s.executionCount);
        if (executionCount < opts.minExecutions) continue;
        insights.push(toInsight(input.connectionId, burst, executionCount, shape, opts));
      }
    }

    return insights
      .sort((a, b) => b.cumulativeTimeMs - a.cumulativeTimeMs || b.executionCount - a.executionCount)
      .slice(0, opts.maxInsights);
  }

  /**
   * Return the equality columns if `sample` is a repeated-point-lookup shape,
   * else null. MongoDB filters are read from the canonical JSON; SQL is parsed.
   */
  private detectPointLookup(sample: WorkloadSample): LookupShape | null {
    return sample.engine === 'mongodb'
      ? detectMongoPointLookup(sample.normalizedQuery)
      : this.detectSqlPointLookup(sample.normalizedQuery);
  }

  private detectSqlPointLookup(normalizedQuery: string): LookupShape | null {
    let ast: unknown;
    try {
      ast = this.parser.astify(normalizedQuery, { database: 'MySQL' });
    } catch {
      return null;
    }
    const node = Array.isArray(ast) ? ast[0] : ast;
    if (!node || typeof node !== 'object') return null;
    const stmt = node as Record<string, unknown>;
    if (stmt['type'] !== 'select') return null;
    const where = stmt['where'];
    if (!where) return null;

    const cols = collectEqualityColumns(where);
    // `null` ⇒ a disqualifying predicate (range, OR, function, …) was present.
    if (cols === null) return null;
    return isLookupColumnSet(cols) ? { fields: cols } : null;
  }
}

/* ---------- burst grouping ---------- */

function buildBursts(samples: WorkloadSample[], gapMs: number): Burst[] {
  const sorted = [...samples].sort((a, b) => msOf(a.windowStart) - msOf(b.windowStart));
  const bursts: Burst[] = [];
  for (const s of sorted) {
    const start = msOf(s.windowStart);
    const end = Math.max(start, msOf(s.windowEnd));
    const current = bursts[bursts.length - 1];
    if (current && start - current.endMs <= gapMs) {
      current.samples.push(s);
      current.endMs = Math.max(current.endMs, end);
    } else {
      bursts.push({ samples: [s], startMs: start, endMs: end });
    }
  }
  return bursts;
}

function toInsight(
  connectionId: string,
  burst: Burst,
  executionCount: number,
  shape: LookupShape,
  opts: WorkloadAnalysisOptions,
): WorkloadInsight {
  const head = burst.samples[0]!;
  const cumulativeTimeMs = sum(burst.samples, (s) => s.totalTimeMs);
  const rowsExamined = sum(burst.samples, (s) => s.rowsExamined);
  const rowsReturned = sum(burst.samples, (s) => s.rowsReturned);
  const indexedExecutions = sum(burst.samples, (s) => (s.usesIndex ? s.executionCount : 0));
  const usesIndex = indexedExecutions * 2 >= executionCount;
  const avgExecutionTimeMs = executionCount > 0 ? cumulativeTimeMs / executionCount : 0;
  const windowFrom = new Date(burst.startMs).toISOString();
  const windowTo = new Date(burst.endMs).toISOString();
  const windowMs = Math.max(0, burst.endMs - burst.startMs);

  return {
    id: `${head.fingerprint}:${windowFrom}`,
    connectionId,
    engine: head.engine,
    kind: 'n-plus-one',
    severity: severityFor(executionCount, cumulativeTimeMs),
    fingerprint: head.fingerprint,
    normalizedQuery: head.normalizedQuery,
    databaseName: head.databaseName,
    targetName: head.targetName,
    queryType: head.queryType,
    executionCount,
    windowMs,
    windowFrom,
    windowTo,
    cumulativeTimeMs,
    avgExecutionTimeMs,
    rowsExamined,
    rowsReturned,
    usesIndex,
    batchingCandidate: true,
    title: `${executionCount.toLocaleString('en-US')} similar queries in ${formatDuration(windowMs)}`,
    rationale: rationaleFor({
      targetName: head.targetName,
      fields: shape.fields,
      executionCount,
      windowMs,
      cumulativeTimeMs,
      avgExecutionTimeMs,
      usesIndex,
      fast: avgExecutionTimeMs <= opts.fastExecutionMs,
    }),
    remediation: remediationFor(head.engine, shape.fields),
  };
}

/* ---------- SQL predicate inspection ---------- */

const SQL_EQUALITY_OPS = new Set(['=', 'IN']);

/**
 * Collect the columns compared with equality in a WHERE tree. Returns `null`
 * (disqualified) if any non-equality predicate is present — a range operator,
 * an `OR`, or a function/expression on the left — since those break the clean
 * "lookup by key" shape an N+1 batches away.
 */
function collectEqualityColumns(node: unknown): string[] | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n['type'] !== 'binary_expr') return null;
  const op = String(n['operator']);

  if (op === 'AND') {
    const left = collectEqualityColumns(n['left']);
    const right = collectEqualityColumns(n['right']);
    if (left === null || right === null) return null;
    return [...left, ...right];
  }
  // OR cannot be served by a single batched lookup — disqualify.
  if (op === 'OR') return null;
  if (!SQL_EQUALITY_OPS.has(op)) return null;

  const col = columnOf(n['left']);
  return col ? [col] : null;
}

function columnOf(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'column_ref' && typeof n['column'] === 'string') return n['column'];
  return null;
}

/* ---------- MongoDB filter inspection ---------- */

const MONGO_EQ_OPS = new Set(['$eq', '$in']);

function detectMongoPointLookup(normalizedQuery: string): LookupShape | null {
  let command: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(normalizedQuery);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    command = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const filter = mongoFilter(command);
  if (filter === undefined) return null;
  const cols = collectMongoEqualityFields(filter);
  if (cols === null) return null;
  return isLookupColumnSet(cols) ? { fields: cols } : null;
}

/** Locate the read predicate across the command shapes we recognize. */
function mongoFilter(command: Record<string, unknown>): unknown {
  if ('find' in command) return command['filter'];
  if ('count' in command || 'distinct' in command) return command['query'];
  if ('aggregate' in command && Array.isArray(command['pipeline'])) {
    for (const stage of command['pipeline']) {
      if (stage && typeof stage === 'object' && '$match' in (stage as Record<string, unknown>)) {
        return (stage as Record<string, unknown>)['$match'];
      }
    }
  }
  return undefined;
}

/** Equality fields in a Mongo filter, or `null` if a disqualifying op appears. */
function collectMongoEqualityFields(filter: unknown): string[] | null {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const fields: string[] = [];
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '$and') {
      if (!Array.isArray(value)) return null;
      for (const sub of value) {
        const subFields = collectMongoEqualityFields(sub);
        if (subFields === null) return null;
        fields.push(...subFields);
      }
      continue;
    }
    // $or / $nor / other top-level operators can't be a single batched lookup.
    if (key.startsWith('$')) return null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const ops = Object.keys(value as Record<string, unknown>);
      // Bare nested object with no operators is treated as an equality match.
      if (ops.length > 0 && !ops.every((op) => MONGO_EQ_OPS.has(op))) return null;
    }
    fields.push(key);
  }
  return fields;
}

/* ---------- shared shape rule ---------- */

const KEY_LIKE = /(^|[._])(id|_id|key|uuid|guid)$/i;

/**
 * A repeated-lookup shape is one or two equality columns. A single equality
 * column always qualifies; two qualify only when they look like keys (the
 * composite-key / two-foreign-key lookup), which keeps wide filter queries
 * like `WHERE a = ? AND b = ? AND c = ?` from being mistaken for N+1.
 */
function isLookupColumnSet(cols: string[]): boolean {
  const distinct = [...new Set(cols)];
  if (distinct.length === 1) return true;
  if (distinct.length === 2) return distinct.every((c) => KEY_LIKE.test(c) || c.length <= 3);
  return false;
}

/* ---------- scoring + copy ---------- */

function severityFor(executionCount: number, cumulativeTimeMs: number): RecommendationSeverity {
  if (cumulativeTimeMs >= 5000 || executionCount >= 500) return 'critical';
  if (cumulativeTimeMs >= 1000 || executionCount >= 100) return 'high';
  if (cumulativeTimeMs >= 250 || executionCount >= 30) return 'medium';
  return 'low';
}

function rationaleFor(args: {
  targetName: string;
  fields: string[];
  executionCount: number;
  windowMs: number;
  cumulativeTimeMs: number;
  avgExecutionTimeMs: number;
  usesIndex: boolean;
  fast: boolean;
}): string {
  const fieldList = args.fields.join(', ');
  const lead =
    `\`${args.targetName}\` ran the same lookup on (${fieldList}) ` +
    `${args.executionCount.toLocaleString('en-US')} times in ${formatDuration(args.windowMs)}, ` +
    `${formatMs(args.cumulativeTimeMs)} cumulative (~${formatMs(args.avgExecutionTimeMs)} each).`;
  const pattern = args.fast
    ? ' Each query is individually fast, but the repetition is a classic N+1 — typically one query per row of a parent result.'
    : ' The repeated, similarly-shaped lookups are a classic N+1 pattern — typically one query per row of a parent result.';
  const indexNote = args.usesIndex
    ? ' It is already indexed, so adding an index will not help; the fix is to remove the repetition.'
    : '';
  return lead + pattern + indexNote;
}

function remediationFor(engine: DatabaseEngine, fields: string[]): string {
  const fieldList = fields.join(', ');
  return engine === 'mongodb'
    ? `Collapse these per-row lookups on (${fieldList}) into one query: a single \`$in\` over the collected keys, a \`$lookup\` against the parent pipeline, denormalization, or prefetching the documents up front.`
    : `Collapse these per-row lookups on (${fieldList}) into one query: a single \`WHERE ${fields[0] ?? 'key'} IN (...)\`, a JOIN against the parent query, or eager/preloading in your ORM/data layer.`;
}

/* ---------- helpers ---------- */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)} min`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function msOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }
  return map;
}
