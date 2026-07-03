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
 * Postgres rules (Phase 7): the shared missing/composite rules via the
 * PostgresQL parser dialect, redundant-index detection (same-method prefix or
 * duplicate), unused-index detection from `pg_stat_user_indexes.idx_scan`,
 * expression-index suggestions when a function or cast wrapped around a column
 * defeats a plain index (e.g. `LOWER(email) = ?`), and GIN suggestions for
 * JSONB/array containment predicates (`@>`, `&&`).
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
import { parseableSql, sqlDialectOf } from '@main/application/analysis/sql-dialect';

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
    // Prefix/duplicate detection is a SQL-engine rule; Mongo unused-index
    // detection is handled separately by detectUnusedIndexes.
    if (input.engine === 'mongodb') return [];
    const recs: Recommendation[] = [];
    const byTarget = groupBy(input.existingIndexes, (i) => `${i.databaseName}.${i.targetName}`);
    for (const indexes of byTarget.values()) {
      for (const a of indexes) {
        if (a.primary || a.name === 'PRIMARY') continue;
        // A unique index enforces a constraint, so it is never "redundant"
        // even if its columns are covered by another index.
        if (a.unique) continue;
        // Find the index that makes `a` redundant — a longer index `a` is a
        // left-prefix of, or an exact duplicate we deterministically drop `a`
        // in favor of. The predicate fires for exactly one side of a pair.
        const covering = indexes.find((b) => b !== a && !b.primary && makesRedundant(a, b));
        if (!covering) continue;
        const duplicate = sameFields(a, covering);
        recs.push({
          id: randomUUID(),
          connectionId: input.connectionId,
          engine: input.engine,
          kind: 'redundant-index',
          severity: 'low',
          databaseName: a.databaseName,
          targetName: a.targetName,
          fields: a.fields,
          ddl: sqlDropIndex(input.engine, a),
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
    // Unused-index detection needs a per-index usage counter: MongoDB
    // $indexStats accesses, or Postgres pg_stat_user_indexes.idx_scan. MySQL
    // has no equivalent the connector collects, so the rule stays silent there.
    if (input.engine === 'mysql') return [];
    const engine = input.engine;
    // Only conclude "unused" for targets that actually saw query activity
    // in the observation window — otherwise a zero count just means nothing ran.
    const activeTargets = new Set(
      input.queries.filter((q) => q.engine === engine).map((q) => q.targetName),
    );
    const recs: Recommendation[] = [];
    for (const idx of input.existingIndexes) {
      // No usage data → cannot conclude anything (needs server privileges).
      if (idx.accessCount == null) continue;
      // Mandatory indexes: Mongo's _id_, and anything backing a primary key.
      if (idx.name === '_id_' || idx.primary) continue;
      if (idx.accessCount > 0) continue;
      if (!activeTargets.has(idx.targetName)) continue;
      const fieldList = fieldNames(idx.fields).join(', ');
      const windowNoun =
        engine === 'postgres'
          ? 'since PostgreSQL statistics were last reset'
          : 'over the observation window';
      recs.push({
        id: randomUUID(),
        connectionId: input.connectionId,
        engine,
        kind: 'unused-index',
        severity: 'low',
        databaseName: idx.databaseName,
        targetName: idx.targetName,
        fields: idx.fields,
        ddl:
          engine === 'postgres'
            ? `DROP INDEX "${idx.name}";`
            : `db.${idx.targetName}.dropIndex("${idx.name}");`,
        rationale: idx.unique
          ? `Index \`${idx.name}\` (${fieldList}) on \`${idx.targetName}\` recorded 0 accesses ${windowNoun}. It appears unused, but it is a unique index — confirm the uniqueness constraint is no longer needed before dropping it.`
          : `Index \`${idx.name}\` (${fieldList}) on \`${idx.targetName}\` recorded 0 accesses ${windowNoun} despite query activity on \`${idx.targetName}\`. It appears unused.`,
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
      ...this.suggestExpressionIndexes(input),
      ...this.suggestGinIndexes(input),
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

  /**
   * Postgres: a predicate like `LOWER(email) = ?` or `email::text = ?` cannot
   * use a plain b-tree index on the bare column — the exact expression must be
   * indexed. Suggest that expression index for offending queries, which both
   * fixes the query and explains *why* the existing index was not used.
   */
  private suggestExpressionIndexes(input: RecommendationInput): Recommendation[] {
    if (input.engine !== 'postgres') return [];
    const recs: Recommendation[] = [];
    for (const q of input.queries) {
      if (!isOffending(q)) continue;
      const expressions = this.extractWrappedPredicates(q);
      for (const expr of expressions) {
        if (expressionIndexExists(q.targetName, expr, input.existingIndexes)) continue;
        const idxName = `idx_${q.targetName}_${expr.column}_expr`.slice(0, 63);
        recs.push({
          id: randomUUID(),
          connectionId: input.connectionId,
          engine: 'postgres',
          kind: 'expression-index',
          severity: severityFor(candidateStats(q)),
          databaseName: q.databaseName,
          targetName: q.targetName,
          fields: [{ name: expr.text, direction: 1 }],
          ddl: `CREATE INDEX ${idxName} ON ${q.targetName} (${expr.text});`,
          rationale: `This query filters on \`${expr.text}\`, not on \`${expr.column}\` directly. Wrapping the column in a ${expr.kind} prevents PostgreSQL from using a plain index on \`${expr.column}\` — an expression index on \`${expr.text}\` matches the predicate exactly.`,
          estimatedImpact: `Turns the ${ENGINE_NOUNS.postgres.scan} on \`${q.targetName}\` into an index lookup for this predicate.`,
          sourceFingerprints: [q.fingerprint],
          createdAt: new Date().toISOString(),
          dismissed: false,
        });
      }
    }
    return recs;
  }

  /**
   * Postgres: JSONB / array containment (`@>`, `&&`) is not served by b-tree
   * at all; a GIN index is the engine's answer. Detected textually on the
   * normalized statement because these operators sit outside what the SQL
   * parser handles reliably.
   */
  private suggestGinIndexes(input: RecommendationInput): Recommendation[] {
    if (input.engine !== 'postgres') return [];
    const recs: Recommendation[] = [];
    for (const q of input.queries) {
      if (!isOffending(q)) continue;
      for (const column of extractContainmentColumns(q.normalizedQuery)) {
        if (ginIndexExists(q.targetName, column, input.existingIndexes)) continue;
        const idxName = `idx_${q.targetName}_${column}_gin`.slice(0, 63);
        recs.push({
          id: randomUUID(),
          connectionId: input.connectionId,
          engine: 'postgres',
          kind: 'gin-index',
          severity: severityFor(candidateStats(q)),
          databaseName: q.databaseName,
          targetName: q.targetName,
          fields: [{ name: column, direction: 1 }],
          ddl: `CREATE INDEX ${idxName} ON ${q.targetName} USING GIN (${column});`,
          rationale: `This query uses a containment operator on \`${column}\`, which a b-tree index cannot serve. A GIN index supports JSONB and array containment directly. For JSONB filtered only with \`@>\`, the \`jsonb_path_ops\` operator class gives a smaller, faster index.`,
          estimatedImpact: `Turns the ${ENGINE_NOUNS.postgres.scan} on \`${q.targetName}\` into a GIN index lookup for this predicate.`,
          sourceFingerprints: [q.fingerprint],
          createdAt: new Date().toISOString(),
          dismissed: false,
        });
      }
    }
    return recs;
  }

  /** Function- or cast-wrapped columns compared to a value in the WHERE clause. */
  private extractWrappedPredicates(q: QueryRecord): WrappedPredicate[] {
    let ast: unknown;
    try {
      ast = this.parser.astify(parseableSql(q.normalizedQuery, q.engine), {
        database: sqlDialectOf(q.engine),
      });
    } catch {
      return [];
    }
    const node = Array.isArray(ast) ? ast[0] : ast;
    if (!node || typeof node !== 'object') return [];
    const out: WrappedPredicate[] = [];
    walkWhereForWrapped((node as Record<string, unknown>)['where'], out);
    // De-duplicate by rendered expression.
    const seen = new Set<string>();
    return out.filter((e) => (seen.has(e.text) ? false : (seen.add(e.text), true)));
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
      ast = this.parser.astify(parseableSql(q.normalizedQuery, q.engine), {
        database: sqlDialectOf(q.engine),
      });
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
    const ddl =
      c.engine === 'mongodb'
        ? mongoCreateIndex(c)
        : c.engine === 'postgres'
          ? pgCreateIndex(c)
          : mysqlCreateIndex(c);
    const engineNoun = ENGINE_NOUNS[c.engine].name;
    const scanNoun = ENGINE_NOUNS[c.engine].scan;
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

const ENGINE_NOUNS: Record<DatabaseEngine, { name: string; scan: string }> = {
  mysql: { name: 'MySQL', scan: 'full table scan' },
  postgres: { name: 'PostgreSQL', scan: 'sequential scan' },
  mongodb: { name: 'MongoDB', scan: 'collection scan' },
};

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

/* ---------- Postgres expression / containment detection ---------- */

interface WrappedPredicate {
  /** Bare column inside the wrapper, e.g. "email". */
  column: string;
  /** Renderable index expression, e.g. "lower(email)" or "(email::text)". */
  text: string;
  kind: 'function' | 'cast';
}

/** Functions safe to index (immutable, single-column). */
const INDEXABLE_FUNCTIONS = new Set(['lower', 'upper']);

function walkWhereForWrapped(node: unknown, out: WrappedPredicate[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n['type'] !== 'binary_expr') return;
  const op = String(n['operator']);
  if (op === 'AND' || op === 'OR') {
    walkWhereForWrapped(n['left'], out);
    walkWhereForWrapped(n['right'], out);
    return;
  }
  if (!EQUALITY_OPS.has(op) && !RANGE_OPS.has(op)) return;
  const wrapped = wrappedPredicateOf(n['left']);
  if (wrapped) out.push(wrapped);
}

/** A function/cast around a single column, on the comparison's left side. */
function wrappedPredicateOf(node: unknown): WrappedPredicate | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n['type'] === 'function') {
    const fn = functionNameOf(n['name']);
    if (!fn || !INDEXABLE_FUNCTIONS.has(fn)) return null;
    const args = (n['args'] as { value?: unknown[] } | undefined)?.value;
    if (!Array.isArray(args) || args.length !== 1) return null;
    const column = columnOf(args[0]);
    if (!column) return null;
    return { column, text: `${fn}(${column})`, kind: 'function' };
  }
  if (n['type'] === 'cast') {
    const column = columnOf(n['expr']);
    const dataType = (n['target'] as { dataType?: string } | undefined)?.dataType;
    if (!column || !dataType) return null;
    return { column, text: `(${column}::${dataType.toLowerCase()})`, kind: 'cast' };
  }
  return null;
}

/** node-sql-parser renders function names as a string or a nested name list. */
function functionNameOf(name: unknown): string | null {
  if (typeof name === 'string') return name.toLowerCase();
  if (name && typeof name === 'object') {
    const parts = (name as { name?: Array<{ value?: string }> }).name;
    const value = Array.isArray(parts) ? parts[parts.length - 1]?.value : undefined;
    if (typeof value === 'string') return value.toLowerCase();
  }
  return null;
}

/**
 * Columns compared with a containment operator (`col @> ?`, `col && ?`) in the
 * normalized statement. `<@` is excluded: GIN serves it for arrays but not for
 * JSONB, and the column type is unknown here.
 */
function extractContainmentColumns(normalizedQuery: string): string[] {
  const out = new Set<string>();
  const re = /("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)\s*(?:@>|&&)\s*\?/g;
  for (const match of normalizedQuery.matchAll(re)) {
    const qualified = match[1] ?? '';
    // Drop any table/alias qualifier and identifier quotes.
    const column = qualified.split('.').pop()?.replace(/"/g, '') ?? '';
    // `&&` is also the (non-standard) boolean AND in some SQL text; requiring a
    // word-like left side keeps false positives out.
    if (column) out.add(column);
  }
  return [...out];
}

function expressionIndexExists(
  targetName: string,
  expr: WrappedPredicate,
  existing: ExistingIndex[],
): boolean {
  // Expression columns come back from the catalog as rendered text like
  // "lower(email)" or "lower((email)::text)" — match on function + column
  // rather than exact text.
  const needle = expr.kind === 'function' ? expr.text.slice(0, expr.text.indexOf('(') + 1) : '::';
  return existing.some((idx) => {
    if (idx.targetName !== targetName) return false;
    const first = idx.fields[0]?.name.toLowerCase().replace(/\s+/g, '') ?? '';
    return first.includes(needle) && first.includes(expr.column.toLowerCase());
  });
}

function ginIndexExists(targetName: string, column: string, existing: ExistingIndex[]): boolean {
  return existing.some(
    (idx) =>
      idx.targetName === targetName &&
      idx.method === 'gin' &&
      idx.fields[0]?.name === column,
  );
}

/** Offending = the analysis says this query scans or reads far too much. */
function isOffending(q: QueryRecord): boolean {
  if (!q.analysis) return false;
  const a = q.analysis;
  return a.fullTableScan || a.collectionScan || a.selectivity < 0.1;
}

/** Candidate-shaped stats for severity scoring of the special-index rules. */
function candidateStats(q: QueryRecord): Pick<Candidate, 'fullScan' | 'rowsExamined'> {
  const a = q.analysis;
  return {
    fullScan: a ? a.fullTableScan || a.collectionScan : false,
    rowsExamined: a?.rowsExamined ?? 0,
  };
}

function mysqlCreateIndex(c: Candidate): string {
  const cols = c.fields.map((f) => (f.direction === -1 ? `${f.name} DESC` : f.name));
  const idxName = `idx_${c.targetName}_${c.fields.map((f) => f.name).join('_')}`.slice(0, 64);
  return `CREATE INDEX \`${idxName}\` ON \`${c.targetName}\` (${cols.join(', ')});`;
}

function pgCreateIndex(c: Candidate): string {
  const cols = c.fields.map((f) => (f.direction === -1 ? `${f.name} DESC` : f.name));
  // Postgres identifiers max out at 63 bytes.
  const idxName = `idx_${c.targetName}_${c.fields.map((f) => f.name).join('_')}`.slice(0, 63);
  return `CREATE INDEX ${idxName} ON ${c.targetName} (${cols.join(', ')});`;
}

function sqlDropIndex(engine: DatabaseEngine, idx: ExistingIndex): string {
  return engine === 'postgres'
    ? `DROP INDEX "${idx.name}";`
    : `DROP INDEX \`${idx.name}\` ON \`${idx.targetName}\`;`;
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

function indexExists(c: Candidate, existing: ExistingIndex[]): boolean {
  const want = c.fields.map((f) => f.name);
  return existing.some(
    (idx) =>
      idx.targetName === c.targetName &&
      // Only b-tree-like indexes serve equality/range/sort candidates — a GIN
      // index on the same column must not suppress a b-tree suggestion.
      isBtreeLike(idx) &&
      want.every((name, i) => idx.fields[i]?.name === name),
  );
}

/** Engines without a method report undefined, which means b-tree. */
function isBtreeLike(idx: ExistingIndex): boolean {
  return idx.method == null || idx.method === 'btree';
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
 * `a` is assumed non-unique (a unique index is never redundant). Only indexes
 * of the same access method are comparable — a GIN index on a column does not
 * make a b-tree on the same column redundant. Two cases:
 *  - `a` is a strict left-prefix of `b` — any lookup `a` serves, `b` serves too.
 *  - `a` and `b` are exact duplicates — keep the unique one, else keep the
 *    lexicographically-smaller name, so exactly one side of the pair fires.
 */
function makesRedundant(a: ExistingIndex, b: ExistingIndex): boolean {
  if ((a.method ?? 'btree') !== (b.method ?? 'btree')) return false;
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

function severityFor(c: Pick<Candidate, 'fullScan' | 'rowsExamined'>): RecommendationSeverity {
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
