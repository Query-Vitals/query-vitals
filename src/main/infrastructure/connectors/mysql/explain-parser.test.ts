import { describe, it, expect } from 'vitest';
import { parseMySqlExplain } from './explain-parser';

/** Minimal but realistic `EXPLAIN FORMAT=JSON` shapes. */
function singleTable(table: Record<string, unknown>): string {
  return JSON.stringify({ query_block: { select_id: 1, table } });
}

describe('parseMySqlExplain — index detection', () => {
  it('flags a full table scan (access_type ALL) with no index', () => {
    const json = singleTable({
      table_name: 'orders',
      access_type: 'ALL',
      key: null,
      rows_examined_per_scan: 50000,
      rows_produced_per_join: 100,
    });
    const { analysis } = parseMySqlExplain(json, 120, 100);
    expect(analysis.fullTableScan).toBe(true);
    expect(analysis.usesIndex).toBe(false);
    expect(analysis.indexesUsed).toEqual([]);
    expect(analysis.collectionScan).toBe(false); // always false for MySQL
  });

  it('records the index name on a ref lookup', () => {
    const json = singleTable({
      table_name: 'orders',
      access_type: 'ref',
      key: 'idx_user_id',
      possible_keys: ['idx_user_id'],
      rows_examined_per_scan: 10,
      rows_produced_per_join: 10,
    });
    const { analysis } = parseMySqlExplain(json, 5, 100);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.fullTableScan).toBe(false);
    expect(analysis.indexesUsed).toEqual(['idx_user_id']);
  });

  it('treats a range scan as index usage', () => {
    const json = singleTable({
      table_name: 'events',
      access_type: 'range',
      key: 'idx_created_at',
      rows_examined_per_scan: 200,
      rows_produced_per_join: 200,
    });
    const { analysis } = parseMySqlExplain(json, 8, 100);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.indexesUsed).toEqual(['idx_created_at']);
  });

  it('counts a full index scan (access_type index) as using an index even without a key', () => {
    const json = singleTable({
      table_name: 'lookup',
      access_type: 'index',
      key: null,
      rows_examined_per_scan: 1000,
      rows_produced_per_join: 1000,
    });
    const { analysis } = parseMySqlExplain(json, 30, 100);
    expect(analysis.usesIndex).toBe(true);
    expect(analysis.fullTableScan).toBe(false);
    expect(analysis.indexesUsed).toEqual([]); // no named key, but index access
  });
});

describe('parseMySqlExplain — joins (nested_loop)', () => {
  const joinJson = JSON.stringify({
    query_block: {
      select_id: 1,
      nested_loop: [
        {
          table: {
            table_name: 'users',
            access_type: 'ALL',
            key: null,
            rows_examined_per_scan: 1000,
            rows_produced_per_join: 1000,
          },
        },
        {
          table: {
            table_name: 'orders',
            access_type: 'ref',
            key: 'idx_user_id',
            rows_examined_per_scan: 5,
            rows_produced_per_join: 5000,
          },
        },
      ],
    },
  });

  it('collects every table in the join', () => {
    const { plan } = parseMySqlExplain(joinJson, 40, 100);
    expect(plan.children).toHaveLength(2);
    expect(plan.children!.map((c) => c.target)).toEqual(['users', 'orders']);
  });

  it('sums rows examined across joined tables and uses the last table for rows returned', () => {
    const { analysis } = parseMySqlExplain(joinJson, 40, 100);
    expect(analysis.rowsExamined).toBe(1005); // 1000 + 5
    expect(analysis.rowsReturned).toBe(5000); // rows_produced_per_join of last table
  });

  it('reports a full scan if ANY joined table scans, while still detecting index use', () => {
    const { analysis } = parseMySqlExplain(joinJson, 40, 100);
    expect(analysis.fullTableScan).toBe(true); // users is ALL
    expect(analysis.usesIndex).toBe(true); // orders uses idx_user_id
    expect(analysis.indexesUsed).toEqual(['idx_user_id']);
  });
});

describe('parseMySqlExplain — plan tree & scoring', () => {
  it('builds a query_block root with a readable detail per access type', () => {
    const json = singleTable({
      table_name: 'orders',
      access_type: 'ALL',
      rows_examined_per_scan: 50000,
      rows_produced_per_join: 100,
    });
    const { plan } = parseMySqlExplain(json, 120, 100);
    expect(plan.stage).toBe('query_block');
    const child = plan.children![0]!;
    expect(child.stage).toBe('ALL');
    expect(child.target).toBe('orders');
    expect(child.detail).toContain('Full table scan');
    expect(child.rowsExamined).toBe(50000);
  });

  it('derives a low score for a slow full scan and a high score for a fast indexed lookup', () => {
    const scan = parseMySqlExplain(
      singleTable({ table_name: 't', access_type: 'ALL', rows_examined_per_scan: 100000, rows_produced_per_join: 5 }),
      500,
      100,
    ).analysis;
    const indexed = parseMySqlExplain(
      singleTable({ table_name: 't', access_type: 'eq_ref', key: 'PRIMARY', rows_examined_per_scan: 1, rows_produced_per_join: 1 }),
      2,
      100,
    ).analysis;
    expect(scan.performanceScore).toBeLessThan(indexed.performanceScore);
    expect(indexed.performanceScore).toBeGreaterThanOrEqual(90);
    expect(scan.scoreBreakdown.indexUsage).toBe(0);
    expect(indexed.scoreBreakdown.indexUsage).toBe(1);
  });

  it('preserves selectivity = returned/examined from the plan', () => {
    const { analysis } = parseMySqlExplain(
      singleTable({ table_name: 't', access_type: 'ref', key: 'k', rows_examined_per_scan: 1000, rows_produced_per_join: 10 }),
      10,
      100,
    );
    expect(analysis.selectivity).toBeCloseTo(0.01, 10);
  });

  it('exposes the parsed JSON as rawPlan', () => {
    const json = singleTable({ table_name: 't', access_type: 'ref', key: 'k' });
    const { rawPlan } = parseMySqlExplain(json, 1, 100);
    expect(rawPlan).toEqual(JSON.parse(json));
  });

  it('throws on malformed EXPLAIN JSON', () => {
    expect(() => parseMySqlExplain('not json', 1, 100)).toThrow();
  });

  it('handles a plan with no table objects gracefully', () => {
    const { analysis, plan } = parseMySqlExplain(JSON.stringify({ query_block: { select_id: 1 } }), 1, 100);
    expect(plan.children).toEqual([]);
    expect(analysis.rowsExamined).toBe(0);
    expect(analysis.usesIndex).toBe(false);
    expect(analysis.selectivity).toBe(1); // no rows examined → perfectly selective
  });
});
