import { describe, it, expect } from 'vitest';
import { parsePostgresExplain } from './pg-explain-parser';

/** Minimal but realistic `EXPLAIN (FORMAT JSON)` shapes. */
function explainJson(plan: Record<string, unknown>, root: Record<string, unknown> = {}): string {
  return JSON.stringify([{ Plan: plan, ...root }]);
}

describe('parsePostgresExplain — index detection', () => {
  it('flags a Seq Scan as a full table scan with no index', () => {
    const json = explainJson({
      'Node Type': 'Seq Scan',
      'Relation Name': 'orders',
      'Plan Rows': 50000,
      'Total Cost': 1200.5,
      Filter: '(status = $1)',
    });
    const { analysis } = parsePostgresExplain(json, 120, 100);
    expect(analysis.fullTableScan).toBe(true);
    expect(analysis.usesIndex).toBe(false);
    expect(analysis.indexesUsed).toEqual([]);
    expect(analysis.collectionScan).toBe(false); // always false for SQL engines
  });

  it('records the index name on an Index Scan', () => {
    const json = explainJson({
      'Node Type': 'Index Scan',
      'Relation Name': 'orders',
      'Index Name': 'idx_orders_user_id',
      'Index Cond': '(user_id = $1)',
      'Plan Rows': 10,
    });
    const { analysis } = parsePostgresExplain(json, 5, 100);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.fullTableScan).toBe(false);
    expect(analysis.indexesUsed).toEqual(['idx_orders_user_id']);
  });

  it('detects index usage on an Index Only Scan', () => {
    const json = explainJson({
      'Node Type': 'Index Only Scan',
      'Relation Name': 'events',
      'Index Name': 'idx_events_created_at',
      'Plan Rows': 200,
    });
    const { analysis } = parsePostgresExplain(json, 8, 100);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.indexesUsed).toEqual(['idx_events_created_at']);
  });

  it('detects the index behind a Bitmap Heap Scan via its Bitmap Index Scan child', () => {
    const json = explainJson({
      'Node Type': 'Bitmap Heap Scan',
      'Relation Name': 'orders',
      'Recheck Cond': '(status = $1)',
      'Plan Rows': 400,
      Plans: [
        {
          'Node Type': 'Bitmap Index Scan',
          'Index Name': 'idx_orders_status',
          'Plan Rows': 400,
        },
      ],
    });
    const { analysis } = parsePostgresExplain(json, 10, 100);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.fullTableScan).toBe(false);
    expect(analysis.indexesUsed).toEqual(['idx_orders_status']);
  });
});

describe('parsePostgresExplain — joins', () => {
  const joinJson = explainJson({
    'Node Type': 'Nested Loop',
    'Join Type': 'Inner',
    'Plan Rows': 5000,
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Relation Name': 'users',
        'Plan Rows': 1000,
      },
      {
        'Node Type': 'Index Scan',
        'Relation Name': 'orders',
        'Index Name': 'idx_orders_user_id',
        'Index Cond': '(user_id = users.id)',
        'Plan Rows': 5,
      },
    ],
  });

  it('keeps the join hierarchy in the plan tree', () => {
    const { plan } = parsePostgresExplain(joinJson, 40, 100);
    expect(plan.stage).toBe('Query Plan');
    const join = plan.children![0]!;
    expect(join.stage).toBe('Nested Loop');
    expect(join.children).toHaveLength(2);
    expect(join.children!.map((c) => c.target)).toEqual(['users', 'orders']);
  });

  it('sums rows examined across scan nodes and takes rows returned from the root', () => {
    const { analysis } = parsePostgresExplain(joinJson, 40, 100);
    expect(analysis.rowsExamined).toBe(1005); // 1000 + 5
    expect(analysis.rowsReturned).toBe(5000); // root Plan Rows
  });

  it('reports a full scan if ANY node seq-scans, while still detecting index use', () => {
    const { analysis } = parsePostgresExplain(joinJson, 40, 100);
    expect(analysis.fullTableScan).toBe(true); // users is Seq Scan
    expect(analysis.usesIndex).toBe(true); // orders uses the index
  });
});

describe('parsePostgresExplain — ANALYZE / BUFFERS figures', () => {
  const analyzedJson = explainJson(
    {
      'Node Type': 'Seq Scan',
      'Relation Name': 'orders',
      'Plan Rows': 120, // stale estimate — actuals below should win
      'Actual Rows': 80,
      'Actual Loops': 1,
      'Rows Removed by Filter': 49920,
      'Shared Hit Blocks': 380,
      'Shared Read Blocks': 12,
      Filter: '(status = 3)',
    },
    { 'Execution Time': 42.7 },
  );

  it('uses actual rows + rows removed by filter for rows examined', () => {
    const { analysis } = parsePostgresExplain(analyzedJson, 0, 100);
    expect(analysis.rowsExamined).toBe(50000); // 80 + 49920
    expect(analysis.rowsReturned).toBe(80);
    expect(analysis.selectivity).toBeCloseTo(80 / 50000, 10);
  });

  it('multiplies per-loop actuals by loop count (nested loop inner side)', () => {
    const json = explainJson({
      'Node Type': 'Nested Loop',
      'Actual Rows': 300,
      'Actual Loops': 1,
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'a', 'Actual Rows': 100, 'Actual Loops': 1 },
        {
          'Node Type': 'Index Scan',
          'Relation Name': 'b',
          'Index Name': 'b_pkey',
          'Actual Rows': 3,
          'Actual Loops': 100,
        },
      ],
    });
    const { analysis } = parsePostgresExplain(json, 10, 100);
    expect(analysis.rowsExamined).toBe(400); // 100 + 3×100
  });

  it('surfaces buffer hits/reads in the node detail', () => {
    const { plan } = parsePostgresExplain(analyzedJson, 0, 100);
    const scan = plan.children![0]!;
    expect(scan.detail).toContain('buffers: 380 hit / 12 read');
    expect(scan.detail).toContain('rows removed by filter');
  });

  it('falls back to the reported Execution Time when the caller has no timing', () => {
    const withTime = parsePostgresExplain(analyzedJson, 0, 10).analysis;
    const estimateOnly = parsePostgresExplain(
      explainJson({
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        'Plan Rows': 120,
        'Actual Rows': 80,
        'Actual Loops': 1,
        'Rows Removed by Filter': 49920,
      }),
      0,
      10,
    ).analysis;
    // 42.7ms against a 10ms threshold must cost latency score vs the untimed run.
    expect(withTime.scoreBreakdown.latency).toBeLessThan(estimateOnly.scoreBreakdown.latency);
  });
});

describe('parsePostgresExplain — plan tree & scoring', () => {
  it('labels stages with PostgreSQL node types and readable details', () => {
    const json = explainJson({
      'Node Type': 'Sort',
      'Sort Key': ['orders.created_at DESC'],
      'Plan Rows': 100,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Plan Rows': 50000,
          'Total Cost': 890.1,
        },
      ],
    });
    const { plan } = parsePostgresExplain(json, 120, 100);
    const sort = plan.children![0]!;
    expect(sort.stage).toBe('Sort');
    expect(sort.detail).toContain('Sort by orders.created_at DESC');
    const scan = sort.children![0]!;
    expect(scan.stage).toBe('Seq Scan');
    expect(scan.detail).toContain('Sequential scan of orders');
    expect(scan.estimatedCost).toBeCloseTo(890.1, 5);
  });

  it('derives a low score for a slow seq scan and a high score for a fast indexed lookup', () => {
    const scan = parsePostgresExplain(
      explainJson({
        'Node Type': 'Seq Scan',
        'Relation Name': 't',
        'Plan Rows': 100000,
      }),
      500,
      100,
    ).analysis;
    const indexed = parsePostgresExplain(
      explainJson({
        'Node Type': 'Index Scan',
        'Relation Name': 't',
        'Index Name': 't_pkey',
        'Plan Rows': 1,
      }),
      2,
      100,
    ).analysis;
    expect(scan.performanceScore).toBeLessThan(indexed.performanceScore);
    expect(scan.scoreBreakdown.indexUsage).toBe(0);
    expect(indexed.scoreBreakdown.indexUsage).toBe(1);
  });

  it('exposes the parsed JSON as rawPlan', () => {
    const json = explainJson({ 'Node Type': 'Result' });
    const { rawPlan } = parsePostgresExplain(json, 1, 100);
    expect(rawPlan).toEqual(JSON.parse(json));
  });

  it('throws on malformed EXPLAIN JSON', () => {
    expect(() => parsePostgresExplain('not json', 1, 100)).toThrow();
  });

  it('handles an empty plan gracefully', () => {
    const { analysis } = parsePostgresExplain(JSON.stringify([{}]), 1, 100);
    expect(analysis.rowsExamined).toBe(0);
    expect(analysis.usesIndex).toBe(false);
    expect(analysis.selectivity).toBe(1);
  });
});
