import { describe, it, expect } from 'vitest';
import { parseMongoExplain } from './mongo-explain-parser';

/** A find() that uses an index: FETCH ← IXSCAN. */
const ixscanPlan = {
  queryPlanner: {
    namespace: 'app.users',
    winningPlan: {
      stage: 'FETCH',
      inputStage: {
        stage: 'IXSCAN',
        indexName: 'user_id_1',
        keyPattern: { user_id: 1 },
      },
    },
  },
  executionStats: {
    nReturned: 1,
    executionTimeMillis: 0,
    totalKeysExamined: 1,
    totalDocsExamined: 1,
  },
};

/** A find() that scans the whole collection. */
const collscanPlan = {
  queryPlanner: {
    namespace: 'app.events',
    winningPlan: { stage: 'COLLSCAN', direction: 'forward' },
  },
  executionStats: {
    nReturned: 5,
    executionTimeMillis: 80,
    totalKeysExamined: 0,
    totalDocsExamined: 10000,
  },
};

/** An aggregate() explain nests queryPlanner/executionStats under $cursor. */
const aggregatePlan = {
  stages: [
    {
      $cursor: {
        queryPlanner: {
          winningPlan: {
            stage: 'IXSCAN',
            indexName: 'status_1_created_at_-1',
            keyPattern: { status: 1, created_at: -1 },
          },
        },
        executionStats: {
          nReturned: 20,
          executionTimeMillis: 3,
          totalKeysExamined: 20,
          totalDocsExamined: 0,
        },
      },
    },
    { $group: { _id: '$status' } },
  ],
};

describe('parseMongoExplain', () => {
  it('detects index usage from an IXSCAN winning plan', () => {
    const { analysis } = parseMongoExplain(ixscanPlan, 2);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.collectionScan).toBe(false);
    expect(analysis.fullTableScan).toBe(false);
    expect(analysis.indexesUsed).toContain('user_id_1');
    expect(analysis.rowsExamined).toBe(1);
    expect(analysis.rowsReturned).toBe(1);
    expect(analysis.selectivity).toBe(1);
    expect(analysis.performanceScore).toBeGreaterThan(80);
  });

  it('detects a collection scan and scores it poorly', () => {
    const { analysis } = parseMongoExplain(collscanPlan, 80);
    expect(analysis.usesIndex).toBe(false);
    expect(analysis.collectionScan).toBe(true);
    expect(analysis.indexesUsed).toHaveLength(0);
    expect(analysis.rowsExamined).toBe(10000);
    expect(analysis.selectivity).toBeCloseTo(5 / 10000, 6);
    expect(analysis.scoreBreakdown.scanPenalty).toBe(0);
    expect(analysis.performanceScore).toBeLessThan(20);
  });

  it('reads the nested plan from an aggregate explain', () => {
    const { analysis, plan } = parseMongoExplain(aggregatePlan, 0);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.indexesUsed).toContain('status_1_created_at_-1');
    // No execution time observed → falls back to the engine-reported time.
    expect(analysis.scoreBreakdown.latency).toBeGreaterThan(0);
    expect(plan.stage).toBe('IXSCAN');
  });

  it('treats a covered query (keys but no docs) as examined work', () => {
    const covered = {
      queryPlanner: { winningPlan: { stage: 'PROJECTION_COVERED', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } } },
      executionStats: { nReturned: 50, totalKeysExamined: 50, totalDocsExamined: 0, executionTimeMillis: 1 },
    };
    const { analysis } = parseMongoExplain(covered, 1);
    expect(analysis.rowsExamined).toBe(50);
    expect(analysis.selectivity).toBe(1);
    expect(analysis.usesIndex).toBe(true);
  });
});
