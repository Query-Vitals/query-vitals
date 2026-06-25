/**
 * Default IRecommendationEngine.
 *
 * MySQL rules: missing single-column indexes, composite indexes (ordered
 * equality → range → sort), and redundant-index detection — an index that is a
 * left-prefix of another, or an exact duplicate of another (Phase 4).
 *
 * MongoDB rules: missing single-field indexes and compound indexes, using the
 * same equality → range → sort ordering applied to the command document's
 * filter and sort, plus unused-index detection — indexes that $indexStats
 * reports zero accesses for over the observation window (Phase 4).
 *
 * The engine is pure: same inputs → same suggestions, so the field-ordering,
 * prefix, and redundancy logic is directly unit-testable without a database.
 */

import { randomUUID } from 'node:crypto';
// node-sql-parser is CommonJS; default-import + destructure for ESM interop.
import NodeSqlParser from 'node-sql-parser';
const { Parser } = NodeSqlParser;
type Parser = InstanceType<typeof Parser>;
import type {
  IRecommendationEngine,
  RecommendationInput,
} from '@main/domain/services/recommendation-engine';
import type { ExistingIndex } from '@main/domain/services/database-connector';
import type {
  IndexField,
  Recommendation,
  RecommendationSeverity,
} from '@shared/types/recommendation';
import type { QueryRecord } from '@shared/types/query';
import type { DatabaseEngine } from '@shared/types/database';

interface Candidate {
  engine: DatabaseEngine;
  targetName: string;
  databaseName: string;
  fields: IndexField[];
  rowsExamined: number;
  rowsReturned: number;
  fullScan: boolean;
  fingerprint: string;
}

export class RecommendationEngine implements IRecommendationEngine {
  private readonly parser = new Parser();

  suggestMissingIndexes(input: RecommendationInput): Recommendation[] {
    return this.buildCandidates(input)
      .filter((c) => c.fields.length === 1)
      .filter((c) => !indexExists(c, input.existingIndexes))
      .map((c) => this.toRecommendation(input.connectionId, c));
  }

  suggestCompositeIndexes(input: RecommendationInput): Recommendation[] {
    return this.buildCandidates(input)
      .filter((c) => c.fields.length > 1)
      .filter((c) => !indexExists(c, input.existingIndexes))
      .map((c) => this.toRecommendation(input.connectionId, c));
  }

  detectRedundantIndexes(input: RecommendationInput): Recommendation[] {
    // Prefix/duplicate detection is a MySQL rule; Mongo unused-index detection
    // is handled separately by detectUnusedIndexes.
    if (engineOf(input) === 'mongodb') return [];
    const recs: Recommendation[] = [];
    const byTarget = groupBy(input.existingIndexes, (i) => `${i.databaseName}.${i.targetName}`);
    for (const indexes of byTarget.values()) {
      for (const a of indexes) {
        if (a.name === 'PRIMARY') continue;
        // A unique index enforces a constraint, so it is never "redundant"
        // even if its columns are covered by another index.
        if (a.unique) continue;
        // Find the index that makes `a` redundant — a longer index `a` is a
        // left-prefix of, or an exact duplicate we deterministically drop `a`
        // in favor of. The predicate fires for exactly one side of a pair.
        const covering = indexes.find((b) => b !== a && b.name !== 'PRIMARY' && makesRedundant(a, b));
        if (!covering) continue;
        const duplicate = sameFields(a, covering);
        recs.push({
          id: randomUUID(),
          connectionId: input.connectionId,
          engine: 'mysql',
          kind: 'redundant-index',
          severity: 'low',
          databaseName: a.databaseName,
          targetName: a.targetName,
          fields: a.fields,
          ddl: `DROP INDEX \`${a.name}\` ON \`${a.targetName}\`;`,
          rationale: duplicate
            ? `Index \`${a.name}\` (${fieldNames(a.fields).join(', ')}) is an exact duplicate of \`${covering.name}\`. Two identical indexes cost double the write and storage overhead for no added read benefit.`
            : `Index \`${a.name}\` (${fieldNames(a.fields).join(', ')}) is a left-prefix of \`${covering.name}\` (${fieldNames(covering.fields).join(', ')}), which already serves any query \`${a.name}\` would. It is therefore redundant.`,
          estimatedImpact: `Dropping it removes one index's write and storage overhead on \`${a.targetName}\` with no read penalty — \`${covering.name}\` covers the same lookups.`,
          sourceFingerprints: [],
          createdAt: new Date().toISOString(),
          dismissed: false,
        });
      }
    }
    return recs;
  }

  detectUnusedIndexes(input: RecommendationInput): Recommendation[] {
    // Unused-index detection is a MongoDB rule, driven by $indexStats access
    // counts that the Mongo connector attaches to each ExistingIndex.
    if (engineOf(input) !== 'mongodb') return [];
    // Only conclude "unused" for collections that actually saw query activity
    // in the observation window — otherwise a zero count just means nothing ran.
    const activeTargets = new Set(
      input.queries.filter((q) => q.engine === 'mongodb').map((q) => q.targetName),
    );
    const recs: Recommendation[] = [];
    for (const idx of input.existingIndexes) {
      // No $indexStats data → cannot conclude anything (needs server privileges).
      if (idx.accessCount == null) continue;
      // The default _id_ index is mandatory and cannot be dropped.
      if (idx.name === '_id_') continue;
      if (idx.accessCount > 0) continue;
      if (!activeTargets.has(idx.targetName)) continue;
      const fieldList = fieldNames(idx.fields).join(', ');
      recs.push({
        id: randomUUID(),
        connectionId: input.connectionId,
        engine: 'mongodb',
        kind: 'unused-index',
        severity: 'low',
        databaseName: idx.databaseName,
        targetName: idx.targetName,
        fields: idx.fields,
        ddl: `db.${idx.targetName}.dropIndex("${idx.name}");`,
        rationale: idx.unique
          ? `Index \`${idx.name}\` (${fieldList}) on \`${idx.targetName}\` recorded 0 accesses over the observation window. It appears unused, but it is a unique index — confirm the uniqueness constraint is no longer needed before dropping it.`
          : `Index \`${idx.name}\` (${fieldList}) on \`${idx.targetName}\` recorded 0 accesses over the observation window despite query activity on the collection. It appears unused.`,
        estimatedImpact: `Dropping it removes the write and storage overhead of maintaining \`${idx.name}\` on every insert and update, with no observed read benefit.`,
        sourceFingerprints: [],
        createdAt: new Date().toISOString(),
        dismissed: false,
      });
    }
    return recs;
  }

  generateAll(input: RecommendationInput): Recommendation[] {
    const all = [
      ...this.suggestMissingIndexes(input),
      ...this.suggestCompositeIndexes(input),
      ...this.detectRedundantIndexes(input),
      ...this.detectUnusedIndexes(input),
    ];
    // De-duplicate by DDL, keep the highest severity, then sort.
    const byDdl = new Map<string, Recommendation>();
    for (const rec of all) {
      const existing = byDdl.get(rec.ddl);
      if (!existing || severityWeight(rec.severity) > severityWeight(existing.severity)) {
        byDdl.set(rec.ddl, rec);
      }
    }
    return [...byDdl.values()].sort(
      (a, b) => severityWeight(b.severity) - severityWeight(a.severity),
    );
  }

  /** Extract one index candidate per offending query (either engine). */
  private buildCandidates(input: RecommendationInput): Candidate[] {
    const candidates: Candidate[] = [];
    for (const q of input.queries) {
      if (!q.analysis) continue;
      const a = q.analysis;
      const scanned = a.fullTableScan || a.collectionScan;
      const offending = scanned || a.selectivity < 0.1;
      if (!offending) continue;
      const fields =
        q.engine === 'mongodb' ? extractMongoIndexFields(q) : this.extractIndexFields(q);
      if (!fields.length) continue;
      candidates.push({
        engine: q.engine,
        targetName: q.targetName,
        databaseName: q.databaseName,
        fields,
        rowsExamined: a.rowsExamined,
        rowsReturned: a.rowsReturned,
        fullScan: scanned,
        fingerprint: q.fingerprint,
      });
    }
    return candidates;
  }

  /** Order: equality predicates → first range predicate → sort columns. */
  private extractIndexFields(q: QueryRecord): IndexField[] {
    let ast: unknown;
    try {
      ast = this.parser.astify(q.normalizedQuery, { database: 'MySQL' });
    } catch {
      return [];
    }
    const node = Array.isArray(ast) ? ast[0] : ast;
    if (!node || typeof node !== 'object') return [];
    const stmt = node as Record<string, unknown>;

    const equality: string[] = [];
    const range: string[] = [];
    walkWhere(stmt['where'], equality, range);

    const sort: IndexField[] = [];
    const orderby = stmt['orderby'];
    if (Array.isArray(orderby)) {
      for (const o of orderby) {
        const col = columnOf((o as Record<string, unknown>)['expr']);
        if (col) sort.push({ name: col, direction: (o as { type?: string }).type === 'DESC' ? -1 : 1 });
      }
    }

    const seen = new Set<string>();
    const fields: IndexField[] = [];
    const push = (name: string, direction: 1 | -1): void => {
      if (seen.has(name)) return;
      seen.add(name);
      fields.push({ name, direction });
    };
    equality.forEach((c) => push(c, 1));
    if (range[0]) push(range[0], 1); // a single range column can use the index
    sort.forEach((f) => push(f.name, f.direction));
    return fields;
  }

  private toRecommendation(connectionId: string, c: Candidate): Recommendation {
    const kind: Recommendation['kind'] =
      c.fields.length === 1
        ? 'missing-index'
        : c.engine === 'mongodb'
          ? 'compound-index'
          : 'composite-index';
    const fieldList = fieldNames(c.fields).join(', ');
    const ddl = c.engine === 'mongodb' ? mongoCreateIndex(c) : mysqlCreateIndex(c);
    const engineNoun = c.engine === 'mongodb' ? 'MongoDB' : 'MySQL';
    const scanNoun = c.engine === 'mongodb' ? 'collection scan' : 'full table scan';
    const examinedNoun = c.engine === 'mongodb' ? 'documents' : 'rows';

    return {
      id: randomUUID(),
      connectionId,
      engine: c.engine,
      kind,
      severity: severityFor(c),
      databaseName: c.databaseName,
      targetName: c.targetName,
      fields: c.fields,
      ddl,
      rationale: c.fullScan
        ? `This query runs a ${scanNoun} on \`${c.targetName}\`. An index on (${fieldList}) lets ${engineNoun} seek directly to the matching ${examinedNoun}.`
        : `This query has poor selectivity on \`${c.targetName}\` (examines ~${Math.round(c.rowsExamined)} ${examinedNoun} to return ~${Math.round(c.rowsReturned)}). An index on (${fieldList}) narrows the search.`,
      estimatedImpact: reductionImpact(c, examinedNoun),
      sourceFingerprints: [c.fingerprint],
      createdAt: new Date().toISOString(),
      dismissed: false,
    };
  }
}

/* ---------- helpers ---------- */

const EQUALITY_OPS = new Set(['=', 'IN']);
const RANGE_OPS = new Set(['>', '<', '>=', '<=', 'BETWEEN', '<>', '!=']);

function walkWhere(node: unknown, equality: string[], range: string[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'binary_expr') {
    const op = String(n['operator']);
    if (op === 'AND' || op === 'OR') {
      walkWhere(n['left'], equality, range);
      walkWhere(n['right'], equality, range);
      return;
    }
    const col = columnOf(n['left']);
    if (col) {
      if (EQUALITY_OPS.has(op)) equality.push(col);
      else if (RANGE_OPS.has(op)) range.push(col);
    }
  }
}

function columnOf(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'column_ref' && typeof n['column'] === 'string') return n['column'];
  return null;
}

function mysqlCreateIndex(c: Candidate): string {
  const cols = c.fields.map((f) => (f.direction === -1 ? `${f.name} DESC` : f.name));
  const idxName = `idx_${c.targetName}_${c.fields.map((f) => f.name).join('_')}`.slice(0, 64);
  return `CREATE INDEX \`${idxName}\` ON \`${c.targetName}\` (${cols.join(', ')});`;
}

/* ---------- MongoDB index extraction ---------- */

const MONGO_EQ_OPS = new Set(['$eq', '$in']);
const MONGO_RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne']);

function mongoCreateIndex(c: Candidate): string {
  const keys = c.fields.map((f) => `${quoteMongoField(f.name)}: ${f.direction}`).join(', ');
  const name = c.fields.map((f) => `${f.name}_${f.direction}`).join('_').slice(0, 127);
  return `db.${c.targetName}.createIndex({ ${keys} }, { name: "${name}" });`;
}

/** Quote a field only when it isn't a bare identifier (e.g. dotted paths). */
function quoteMongoField(field: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field) ? field : `"${field}"`;
}

/**
 * Order Mongo index fields by the ESR rule: equality predicates, then the
 * first range predicate, then sort fields — the same rule used for MySQL.
 */
function extractMongoIndexFields(q: QueryRecord): IndexField[] {
  let command: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(q.rawQuery);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    command = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const { filter, sort } = mongoFilterAndSort(command);
  const equality: string[] = [];
  const range: string[] = [];
  walkMongoFilter(filter, equality, range);

  const sortFields: IndexField[] = [];
  if (sort && typeof sort === 'object' && !Array.isArray(sort)) {
    for (const [name, dir] of Object.entries(sort as Record<string, unknown>)) {
      sortFields.push({ name, direction: Number(dir) === -1 ? -1 : 1 });
    }
  }

  const seen = new Set<string>();
  const fields: IndexField[] = [];
  const push = (name: string, direction: 1 | -1): void => {
    if (seen.has(name)) return;
    seen.add(name);
    fields.push({ name, direction });
  };
  equality.forEach((f) => push(f, 1));
  if (range[0]) push(range[0], 1); // a single range field can use the index
  sortFields.forEach((f) => push(f.name, f.direction));
  return fields;
}

/** Locate the query predicate and sort spec across the various command shapes. */
function mongoFilterAndSort(command: Record<string, unknown>): {
  filter: unknown;
  sort: unknown;
} {
  if ('find' in command) return { filter: command['filter'], sort: command['sort'] };
  if ('count' in command || 'distinct' in command) {
    return { filter: command['query'], sort: undefined };
  }
  if ('findAndModify' in command) return { filter: command['query'], sort: command['sort'] };
  if ('update' in command) return { filter: firstArrayQuery(command['updates']), sort: undefined };
  if ('delete' in command) return { filter: firstArrayQuery(command['deletes']), sort: undefined };
  if ('aggregate' in command && Array.isArray(command['pipeline'])) {
    let filter: unknown;
    let sort: unknown;
    for (const stage of command['pipeline']) {
      if (!stage || typeof stage !== 'object') continue;
      const s = stage as Record<string, unknown>;
      if (filter === undefined && '$match' in s) filter = s['$match'];
      if (sort === undefined && '$sort' in s) sort = s['$sort'];
    }
    return { filter, sort };
  }
  return { filter: undefined, sort: undefined };
}

/** The `q` filter of the first entry in an update/delete batch array. */
function firstArrayQuery(value: unknown): unknown {
  if (Array.isArray(value) && value[0] && typeof value[0] === 'object') {
    return (value[0] as Record<string, unknown>)['q'];
  }
  return undefined;
}

function walkMongoFilter(filter: unknown, equality: string[], range: string[]): void {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return;
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === '$and') {
      if (Array.isArray(value)) value.forEach((sub) => walkMongoFilter(sub, equality, range));
      continue;
    }
    // $or / $nor can't be satisfied by a single compound index — skip them.
    if (key.startsWith('$')) continue;
    classifyMongoField(key, value, equality, range);
  }
}

function classifyMongoField(
  field: string,
  value: unknown,
  equality: string[],
  range: string[],
): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ops = Object.keys(value as Record<string, unknown>);
    if (ops.some((op) => MONGO_EQ_OPS.has(op))) equality.push(field);
    else if (ops.some((op) => MONGO_RANGE_OPS.has(op))) range.push(field);
    // Other operators ($regex, $exists, $elemMatch, …) are not index-orderable.
    return;
  }
  // A bare scalar (or array literal) is an equality match.
  equality.push(field);
}

function engineOf(input: { queries: QueryRecord[] }): DatabaseEngine {
  return input.queries[0]?.engine ?? 'mysql';
}

function indexExists(c: Candidate, existing: ExistingIndex[]): boolean {
  const want = c.fields.map((f) => f.name);
  return existing.some(
    (idx) =>
      idx.targetName === c.targetName &&
      want.every((name, i) => idx.fields[i]?.name === name),
  );
}

function isLeftPrefixOf(a: ExistingIndex, b: ExistingIndex): boolean {
  if (a.fields.length >= b.fields.length) return false;
  return a.fields.every((f, i) => b.fields[i]?.name === f.name);
}

function sameFields(a: ExistingIndex, b: ExistingIndex): boolean {
  if (a.fields.length !== b.fields.length) return false;
  return a.fields.every((f, i) => b.fields[i]?.name === f.name && b.fields[i]?.direction === f.direction);
}

/**
 * True when `b` makes `a` redundant and `a` is the one that should be dropped.
 * `a` is assumed non-unique (a unique index is never redundant). Two cases:
 *  - `a` is a strict left-prefix of `b` — any lookup `a` serves, `b` serves too.
 *  - `a` and `b` are exact duplicates — keep the unique one, else keep the
 *    lexicographically-smaller name, so exactly one side of the pair fires.
 */
function makesRedundant(a: ExistingIndex, b: ExistingIndex): boolean {
  if (isLeftPrefixOf(a, b)) return true;
  if (sameFields(a, b)) return b.unique || a.name > b.name;
  return false;
}

/**
 * Frame impact as the reduction a seek would deliver. When the engine examines
 * far more rows/documents than it returns, expressing the ratio ("~4167× fewer
 * rows scanned") tells the user what the index actually saves; otherwise fall
 * back to the raw examined → returned figures.
 */
function reductionImpact(c: Candidate, examinedNoun: string): string {
  const examined = Math.round(c.rowsExamined);
  const returned = Math.round(c.rowsReturned);
  const factor = returned > 0 ? c.rowsExamined / c.rowsReturned : c.rowsExamined;
  if (factor >= 2 && examined > 0) {
    return `~${Math.round(factor).toLocaleString('en-US')}× fewer ${examinedNoun} scanned (≈${examined.toLocaleString('en-US')} → ${returned.toLocaleString('en-US')})`;
  }
  return `Examines ~${examined.toLocaleString('en-US')} ${examinedNoun} → returns ~${returned.toLocaleString('en-US')}`;
}

function severityFor(c: Candidate): RecommendationSeverity {
  if (c.fullScan && c.rowsExamined > 10000) return 'critical';
  if (c.fullScan) return 'high';
  if (c.rowsExamined > 1000) return 'medium';
  return 'low';
}

function severityWeight(s: RecommendationSeverity): number {
  return { critical: 3, high: 2, medium: 1, low: 0 }[s];
}

function fieldNames(fields: IndexField[]): string[] {
  return fields.map((f) => f.name);
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
