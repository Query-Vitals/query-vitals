import { describe, it, expect } from 'vitest';
import { RecommendationEngine } from './recommendation-engine';
import type { RecommendationInput } from '@main/domain/services/recommendation-engine';
import type { IndexAnalysis, QueryRecord } from '@shared/types/query';

const engine = new RecommendationEngine();

function analysis(over: Partial<IndexAnalysis>): IndexAnalysis {
  return {
    usesIndex: false,
    fullTableScan: false,
    collectionScan: false,
    indexesUsed: [],
    rowsExamined: 0,
    rowsReturned: 0,
    selectivity: 1,
    executionPlan: { stage: 'COLLSCAN' },
    rawPlan: null,
    performanceScore: 0,
    scoreBreakdown: { indexUsage: 0, selectivity: 0, scanPenalty: 0, latency: 0 },
    ...over,
  };
}

function mongoQuery(command: object, an: IndexAnalysis, fingerprint = 'fp1'): QueryRecord {
  return {
    id: fingerprint,
    connectionId: 'conn-1',
    engine: 'mongodb',
    source: 'mongo.profiler',
    rawQuery: JSON.stringify(command),
    normalizedQuery: JSON.stringify(command),
    fingerprint,
    queryType: 'find',
    databaseName: 'app',
    targetName: (command as Record<string, string>)['find'] ?? 'unknown',
    executionTimeMs: 50,
    timestamp: new Date().toISOString(),
    analysis: an,
  };
}

function input(queries: QueryRecord[], existingIndexes: RecommendationInput['existingIndexes'] = []): RecommendationInput {
  return { connectionId: 'conn-1', engine: 'mongodb', queries, existingIndexes };
}

describe('RecommendationEngine (MongoDB)', () => {
  it('suggests a compound index ordered equality → range → sort', () => {
    const q = mongoQuery(
      {
        find: 'orders',
        filter: { user_id: 1, status: 'open', total: { $gt: 100 } },
        sort: { created_at: -1 },
      },
      analysis({ collectionScan: true, rowsExamined: 50000, rowsReturned: 12, selectivity: 0.0002 }),
    );
    const recs = engine.suggestCompositeIndexes(input([q]));
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.engine).toBe('mongodb');
    expect(rec.kind).toBe('compound-index');
    expect(rec.fields.map((f) => f.name)).toEqual(['user_id', 'status', 'total', 'created_at']);
    // Equality/range fields are ascending; the sort field keeps its direction.
    expect(rec.fields.find((f) => f.name === 'created_at')!.direction).toBe(-1);
    expect(rec.ddl).toContain('db.orders.createIndex(');
    expect(rec.ddl).toContain('created_at: -1');
    expect(rec.severity).toBe('critical');
  });

  it('suggests a single-field missing index for a one-predicate scan', () => {
    const q = mongoQuery(
      { find: 'sessions', filter: { token: 'abc' } },
      analysis({ collectionScan: true, rowsExamined: 800, rowsReturned: 1, selectivity: 0.00125 }),
    );
    const recs = engine.suggestMissingIndexes(input([q]));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.kind).toBe('missing-index');
    expect(recs[0]!.fields.map((f) => f.name)).toEqual(['token']);
  });

  it('does not suggest an index that already exists', () => {
    const q = mongoQuery(
      { find: 'sessions', filter: { token: 'abc' } },
      analysis({ collectionScan: true, rowsExamined: 800, rowsReturned: 1, selectivity: 0.001 }),
    );
    const recs = engine.suggestMissingIndexes(
      input([q], [
        { name: 'token_1', databaseName: 'app', targetName: 'sessions', fields: [{ name: 'token', direction: 1 }], unique: false },
      ]),
    );
    expect(recs).toHaveLength(0);
  });

  it('ignores well-indexed, selective queries', () => {
    const q = mongoQuery(
      { find: 'orders', filter: { user_id: 1 } },
      analysis({ usesIndex: true, indexesUsed: ['user_id_1'], rowsExamined: 10, rowsReturned: 10, selectivity: 1 }),
    );
    expect(engine.generateAll(input([q]))).toHaveLength(0);
  });

  it('does not run MySQL redundant-index detection for a Mongo connection', () => {
    const q = mongoQuery(
      { find: 'orders', filter: { user_id: 1 } },
      analysis({ usesIndex: true, selectivity: 1 }),
    );
    const recs = engine.detectRedundantIndexes(
      input([q], [
        { name: 'a_1', databaseName: 'app', targetName: 'orders', fields: [{ name: 'a', direction: 1 }], unique: false },
        { name: 'a_1_b_1', databaseName: 'app', targetName: 'orders', fields: [{ name: 'a', direction: 1 }, { name: 'b', direction: 1 }], unique: false },
      ]),
    );
    expect(recs).toHaveLength(0);
  });
});

type Idx = RecommendationInput['existingIndexes'][number];

function idx(name: string, fields: string[], over: Partial<Idx> = {}): Idx {
  return {
    name,
    databaseName: 'shop',
    targetName: 'orders',
    fields: fields.map((f) => ({ name: f, direction: 1 as const })),
    unique: false,
    ...over,
  };
}

function mysqlInput(existingIndexes: Idx[]): RecommendationInput {
  return { connectionId: 'conn-1', engine: 'mysql', queries: [], existingIndexes };
}

describe('RecommendationEngine — redundant indexes (MySQL)', () => {
  it('flags a left-prefix index as redundant and drops the prefix', () => {
    const recs = engine.detectRedundantIndexes(
      mysqlInput([idx('idx_a', ['a']), idx('idx_a_b', ['a', 'b'])]),
    );
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.kind).toBe('redundant-index');
    expect(rec.severity).toBe('low');
    expect(rec.ddl).toBe('DROP INDEX `idx_a` ON `orders`;');
    expect(rec.rationale).toContain('left-prefix');
  });

  it('flags exactly one of two exact-duplicate indexes (keeps the lexicographically smaller name)', () => {
    const recs = engine.detectRedundantIndexes(
      mysqlInput([idx('dup_a', ['a', 'b']), idx('dup_b', ['a', 'b'])]),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.ddl).toBe('DROP INDEX `dup_b` ON `orders`;');
    expect(recs[0]!.rationale).toContain('exact duplicate');
  });

  it('never flags a unique index, even when its columns are covered', () => {
    const recs = engine.detectRedundantIndexes(
      mysqlInput([idx('uq_a', ['a'], { unique: true }), idx('idx_a_b', ['a', 'b'])]),
    );
    expect(recs).toHaveLength(0);
  });

  it('does not flag two independent, non-overlapping indexes', () => {
    const recs = engine.detectRedundantIndexes(
      mysqlInput([idx('idx_a', ['a']), idx('idx_b', ['b'])]),
    );
    expect(recs).toHaveLength(0);
  });
});

describe('RecommendationEngine — unused indexes (MongoDB)', () => {
  const activeQuery = mongoQuery(
    { find: 'orders', filter: { user_id: 1 } },
    analysis({ usesIndex: true, indexesUsed: ['user_id_1'], rowsExamined: 10, rowsReturned: 10, selectivity: 1 }),
  );

  function mIdx(name: string, over: Partial<Idx>): Idx {
    return {
      name,
      databaseName: 'app',
      targetName: 'orders',
      fields: [{ name: 'legacy', direction: 1 }],
      unique: false,
      ...over,
    };
  }

  it('flags an index with zero recorded accesses on an active collection', () => {
    const recs = engine.detectUnusedIndexes(
      input([activeQuery], [mIdx('stale_idx', { accessCount: 0 })]),
    );
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.kind).toBe('unused-index');
    expect(rec.engine).toBe('mongodb');
    expect(rec.ddl).toBe('db.orders.dropIndex("stale_idx");');
  });

  it('never flags the mandatory _id_ index', () => {
    const recs = engine.detectUnusedIndexes(
      input([activeQuery], [mIdx('_id_', { accessCount: 0, fields: [{ name: '_id', direction: 1 }] })]),
    );
    expect(recs).toHaveLength(0);
  });

  it('ignores indexes when $indexStats data is unavailable (accessCount undefined)', () => {
    const recs = engine.detectUnusedIndexes(input([activeQuery], [mIdx('maybe_idx', {})]));
    expect(recs).toHaveLength(0);
  });

  it('does not conclude "unused" for a collection with no observed activity', () => {
    const recs = engine.detectUnusedIndexes(
      input([activeQuery], [mIdx('archive_idx', { accessCount: 0, targetName: 'archive' })]),
    );
    expect(recs).toHaveLength(0);
  });

  it('notes the uniqueness constraint when an unused index is unique', () => {
    const recs = engine.detectUnusedIndexes(
      input([activeQuery], [mIdx('uq_unused', { accessCount: 0, unique: true })]),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.rationale).toContain('unique');
  });

  it('does not run unused-index detection for a MySQL connection', () => {
    const recs = engine.detectUnusedIndexes(mysqlInput([idx('idx_a', ['a'], { accessCount: 0 })]));
    expect(recs).toHaveLength(0);
  });
});

/* ---------- Postgres ---------- */

function pgQuery(normalizedQuery: string, an: IndexAnalysis, over: Partial<QueryRecord> = {}): QueryRecord {
  return {
    id: over.fingerprint ?? 'pg-fp1',
    connectionId: 'conn-1',
    engine: 'postgres',
    source: 'postgres.pg_stat_statements',
    rawQuery: normalizedQuery,
    normalizedQuery,
    fingerprint: 'pg-fp1',
    queryType: 'select',
    databaseName: 'shop',
    targetName: 'orders',
    executionTimeMs: 50,
    timestamp: new Date().toISOString(),
    analysis: an,
    ...over,
  };
}

function pgInput(queries: QueryRecord[], existingIndexes: Idx[] = []): RecommendationInput {
  return { connectionId: 'conn-1', engine: 'postgres', queries, existingIndexes };
}

const seqScan = (): IndexAnalysis =>
  analysis({ fullTableScan: true, rowsExamined: 50000, rowsReturned: 12, selectivity: 0.0002 });

describe('RecommendationEngine (Postgres) — missing/composite indexes', () => {
  it('suggests a composite index ordered equality → range → sort with PostgreSQL DDL', () => {
    const q = pgQuery(
      'SELECT * FROM orders WHERE user_id = ? AND status = ? AND total > ? ORDER BY created_at DESC',
      seqScan(),
    );
    const recs = engine.suggestCompositeIndexes(pgInput([q]));
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.engine).toBe('postgres');
    expect(rec.kind).toBe('composite-index');
    expect(rec.fields.map((f) => f.name)).toEqual(['user_id', 'status', 'total', 'created_at']);
    expect(rec.ddl).toBe(
      'CREATE INDEX idx_orders_user_id_status_total_created_at ON orders (user_id, status, total, created_at DESC);',
    );
    expect(rec.severity).toBe('critical');
  });

  it('suggests a single-column index for a one-predicate seq scan', () => {
    const q = pgQuery('SELECT * FROM orders WHERE user_id = ?', seqScan());
    const recs = engine.suggestMissingIndexes(pgInput([q]));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.ddl).toBe('CREATE INDEX idx_orders_user_id ON orders (user_id);');
  });

  it('does not suggest a b-tree that already exists, but ignores a GIN on the same column', () => {
    const q = pgQuery('SELECT * FROM orders WHERE user_id = ?', seqScan());
    const covered = engine.suggestMissingIndexes(
      pgInput([q], [idx('idx_uid', ['user_id'], { method: 'btree' })]),
    );
    expect(covered).toHaveLength(0);
    const ginOnly = engine.suggestMissingIndexes(
      pgInput([q], [idx('gin_uid', ['user_id'], { method: 'gin' })]),
    );
    expect(ginOnly).toHaveLength(1);
  });
});

describe('RecommendationEngine (Postgres) — redundant & unused indexes', () => {
  it('flags a left-prefix index with PostgreSQL DROP INDEX syntax', () => {
    const recs = engine.detectRedundantIndexes(
      pgInput([], [
        idx('idx_a', ['a'], { method: 'btree' }),
        idx('idx_a_b', ['a', 'b'], { method: 'btree' }),
      ]),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.engine).toBe('postgres');
    expect(recs[0]!.ddl).toBe('DROP INDEX "idx_a";');
  });

  it('does not compare indexes of different access methods', () => {
    const recs = engine.detectRedundantIndexes(
      pgInput([], [
        idx('btree_payload', ['payload'], { method: 'btree' }),
        idx('gin_payload', ['payload'], { method: 'gin' }),
      ]),
    );
    expect(recs).toHaveLength(0);
  });

  it('flags an index with zero idx_scan on an active table, but never a primary key', () => {
    const active = pgQuery('SELECT * FROM orders WHERE id = ?', analysis({ usesIndex: true }));
    const recs = engine.detectUnusedIndexes(
      pgInput([active], [
        idx('orders_pkey', ['id'], { unique: true, primary: true, accessCount: 0 }),
        idx('stale_idx', ['legacy'], { accessCount: 0 }),
        idx('busy_idx', ['user_id'], { accessCount: 512 }),
      ]),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.ddl).toBe('DROP INDEX "stale_idx";');
    expect(recs[0]!.rationale).toContain('statistics were last reset');
  });
});

describe('RecommendationEngine (Postgres) — expression & GIN indexes', () => {
  it('suggests an expression index when a function wraps the filtered column', () => {
    const q = pgQuery('SELECT * FROM users WHERE lower(email) = ?', seqScan(), {
      targetName: 'users',
    });
    const recs = engine.generateAll(pgInput([q]));
    const expr = recs.find((r) => r.kind === 'expression-index');
    expect(expr).toBeDefined();
    expect(expr!.ddl).toBe('CREATE INDEX idx_users_email_expr ON users (lower(email));');
    expect(expr!.rationale).toContain('lower(email)');
  });

  it('suggests an expression index for a cast-wrapped column', () => {
    const q = pgQuery('SELECT * FROM users WHERE email::text = ?', seqScan(), {
      targetName: 'users',
    });
    const recs = engine.generateAll(pgInput([q]));
    const expr = recs.find((r) => r.kind === 'expression-index');
    expect(expr).toBeDefined();
    expect(expr!.ddl).toBe('CREATE INDEX idx_users_email_expr ON users ((email::text));');
  });

  it('does not re-suggest an expression index the catalog already has', () => {
    const q = pgQuery('SELECT * FROM users WHERE lower(email) = ?', seqScan(), {
      targetName: 'users',
    });
    const recs = engine.generateAll(
      pgInput([q], [idx('users_lower_email', ['lower((email)::text)'], { targetName: 'users' })]),
    );
    expect(recs.filter((r) => r.kind === 'expression-index')).toHaveLength(0);
  });

  it('suggests a GIN index for JSONB containment', () => {
    const q = pgQuery('SELECT * FROM events WHERE payload @> ?', seqScan(), {
      targetName: 'events',
    });
    const recs = engine.generateAll(pgInput([q]));
    const gin = recs.find((r) => r.kind === 'gin-index');
    expect(gin).toBeDefined();
    expect(gin!.ddl).toBe('CREATE INDEX idx_events_payload_gin ON events USING GIN (payload);');
  });

  it('suggests a GIN index for array overlap (&&)', () => {
    const q = pgQuery('SELECT * FROM posts WHERE tags && ?', seqScan(), { targetName: 'posts' });
    const recs = engine.generateAll(pgInput([q]));
    expect(recs.some((r) => r.kind === 'gin-index' && r.fields[0]!.name === 'tags')).toBe(true);
  });

  it('does not re-suggest a GIN index that already exists', () => {
    const q = pgQuery('SELECT * FROM events WHERE payload @> ?', seqScan(), {
      targetName: 'events',
    });
    const recs = engine.generateAll(
      pgInput([q], [idx('gin_payload', ['payload'], { targetName: 'events', method: 'gin' })]),
    );
    expect(recs.filter((r) => r.kind === 'gin-index')).toHaveLength(0);
  });

  it('stays silent for indexed, selective queries', () => {
    const q = pgQuery(
      'SELECT * FROM users WHERE lower(email) = ?',
      analysis({ usesIndex: true, rowsExamined: 1, rowsReturned: 1, selectivity: 1 }),
      { targetName: 'users' },
    );
    expect(engine.generateAll(pgInput([q]))).toHaveLength(0);
  });
});
