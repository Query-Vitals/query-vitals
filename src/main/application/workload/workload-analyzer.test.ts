import { describe, it, expect } from 'vitest';
import { WorkloadAnalyzer } from './workload-analyzer';
import type { WorkloadSample } from '@shared/types/workload';
import type { WorkloadAnalysisInput } from '@main/domain/services/workload-analyzer';

const analyzer = new WorkloadAnalyzer();

const BASE = Date.parse('2026-06-24T12:00:00.000Z');

function sample(over: Partial<WorkloadSample>): WorkloadSample {
  return {
    id: 'sample-1',
    connectionId: 'conn-1',
    engine: 'mysql',
    fingerprint: 'fp1',
    normalizedQuery: 'SELECT * FROM users WHERE id = ?',
    queryType: 'select',
    databaseName: 'app',
    targetName: 'users',
    windowStart: new Date(BASE).toISOString(),
    windowEnd: new Date(BASE + 2300).toISOString(),
    executionCount: 84,
    totalTimeMs: 720,
    rowsExamined: 84,
    rowsReturned: 84,
    usesIndex: true,
    ...over,
  };
}

function input(samples: WorkloadSample[], options?: WorkloadAnalysisInput['options']): WorkloadAnalysisInput {
  return { connectionId: 'conn-1', samples, ...(options ? { options } : {}) };
}

describe('WorkloadAnalyzer — SQL N+1 detection', () => {
  it('flags a repeated WHERE id = ? burst with cumulative cost', () => {
    const insights = analyzer.analyze(input([sample({})]));
    expect(insights).toHaveLength(1);
    const i = insights[0]!;
    expect(i.kind).toBe('n-plus-one');
    expect(i.executionCount).toBe(84);
    expect(i.cumulativeTimeMs).toBe(720);
    expect(i.windowMs).toBe(2300);
    expect(i.title).toBe('84 similar queries in 2.3s');
    expect(i.batchingCandidate).toBe(true);
    expect(i.usesIndex).toBe(true); // "indexed but repeated"
    expect(i.remediation).toContain('IN (...)');
  });

  it('detects repeated lookups on a foreign-key column', () => {
    const insights = analyzer.analyze(
      input([sample({ normalizedQuery: 'SELECT * FROM orders WHERE user_id = ?', targetName: 'orders' })]),
    );
    expect(insights).toHaveLength(1);
    expect(insights[0]!.remediation).toContain('user_id');
  });

  it('does not flag bursts below the minimum execution count', () => {
    const insights = analyzer.analyze(input([sample({ executionCount: 5 })]));
    expect(insights).toHaveLength(0);
  });

  it('ignores range predicates — not a point lookup', () => {
    const insights = analyzer.analyze(
      input([sample({ normalizedQuery: 'SELECT * FROM events WHERE created_at > ?' })]),
    );
    expect(insights).toHaveLength(0);
  });

  it('ignores OR predicates — cannot be a single batched lookup', () => {
    const insights = analyzer.analyze(
      input([sample({ normalizedQuery: 'SELECT * FROM users WHERE id = ? OR email = ?' })]),
    );
    expect(insights).toHaveLength(0);
  });

  it('ignores wide multi-column filters that are not key lookups', () => {
    const insights = analyzer.analyze(
      input([sample({ normalizedQuery: 'SELECT * FROM logs WHERE level = ? AND service = ? AND host = ?' })]),
    );
    expect(insights).toHaveLength(0);
  });

  it('escalates severity by cumulative time', () => {
    const insights = analyzer.analyze(
      input([sample({ executionCount: 600, totalTimeMs: 9000 })]),
    );
    expect(insights[0]!.severity).toBe('critical');
  });

  it('reports "not indexed" when the repeated query scans', () => {
    const insights = analyzer.analyze(input([sample({ usesIndex: false })]));
    expect(insights[0]!.usesIndex).toBe(false);
    expect(insights[0]!.rationale).not.toContain('already indexed');
  });
});

describe('WorkloadAnalyzer — burst grouping', () => {
  it('merges samples within the burst gap and splits distant ones', () => {
    const near = sample({
      id: 's2',
      windowStart: new Date(BASE + 5000).toISOString(),
      windowEnd: new Date(BASE + 7000).toISOString(),
      executionCount: 20,
      totalTimeMs: 100,
    });
    const far = sample({
      id: 's3',
      windowStart: new Date(BASE + 10 * 60_000).toISOString(),
      windowEnd: new Date(BASE + 10 * 60_000 + 1000).toISOString(),
      executionCount: 50,
      totalTimeMs: 300,
    });
    const insights = analyzer.analyze(input([sample({}), near, far]));
    // First two merge into one burst (104 execs), the far one is its own burst.
    expect(insights).toHaveLength(2);
    const counts = insights.map((i) => i.executionCount).sort((a, b) => a - b);
    expect(counts).toEqual([50, 104]);
  });

  it('keeps distinct fingerprints separate', () => {
    const other = sample({
      fingerprint: 'fp2',
      normalizedQuery: 'SELECT * FROM products WHERE sku = ?',
      targetName: 'products',
    });
    const insights = analyzer.analyze(input([sample({}), other]));
    expect(insights).toHaveLength(2);
    expect(new Set(insights.map((i) => i.fingerprint))).toEqual(new Set(['fp1', 'fp2']));
  });
});

describe('WorkloadAnalyzer — MongoDB N+1 detection', () => {
  function mongoSample(command: object, over: Partial<WorkloadSample> = {}): WorkloadSample {
    return sample({
      engine: 'mongodb',
      queryType: 'find',
      normalizedQuery: JSON.stringify(command),
      ...over,
    });
  }

  it('flags repeated find-by-_id lookups', () => {
    const insights = analyzer.analyze(
      input([mongoSample({ find: 'users', filter: { _id: '?' } })]),
    );
    expect(insights).toHaveLength(1);
    expect(insights[0]!.remediation).toContain('$in');
  });

  it('flags repeated find by a foreign-key field', () => {
    const insights = analyzer.analyze(
      input([mongoSample({ find: 'orders', filter: { customer_id: '?' }, targetName: 'orders' } as object)]),
    );
    expect(insights).toHaveLength(1);
  });

  it('ignores $or filters', () => {
    const insights = analyzer.analyze(
      input([mongoSample({ find: 'users', filter: { $or: [{ _id: '?' }, { email: '?' }] } })]),
    );
    expect(insights).toHaveLength(0);
  });

  it('ignores range operators in the filter', () => {
    const insights = analyzer.analyze(
      input([mongoSample({ find: 'events', filter: { created_at: { $gt: '?' } } })]),
    );
    expect(insights).toHaveLength(0);
  });
});

describe('WorkloadAnalyzer — ordering and caps', () => {
  it('sorts insights by cumulative time descending', () => {
    const cheap = sample({ fingerprint: 'cheap', totalTimeMs: 100 });
    const pricey = sample({ fingerprint: 'pricey', totalTimeMs: 5000 });
    const insights = analyzer.analyze(input([cheap, pricey]));
    expect(insights.map((i) => i.fingerprint)).toEqual(['pricey', 'cheap']);
  });

  it('respects the maxInsights cap', () => {
    const samples = Array.from({ length: 5 }, (_, k) =>
      sample({ fingerprint: `fp${k}`, normalizedQuery: `SELECT * FROM t${k} WHERE id = ?` }),
    );
    const insights = analyzer.analyze(input(samples, { maxInsights: 2 }));
    expect(insights).toHaveLength(2);
  });
});
