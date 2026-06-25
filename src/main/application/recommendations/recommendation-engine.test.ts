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
  return { connectionId: 'conn-1', queries, existingIndexes };
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

// Redundant detection keys off engineOf(queries); an empty query list defaults
// to MySQL, which is what these rules target.
function mysqlInput(existingIndexes: Idx[]): RecommendationInput {
  return { connectionId: 'conn-1', queries: [], existingIndexes };
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
