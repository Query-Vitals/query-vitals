import { describe, it, expect } from 'vitest';
import { computeScore, computeScoreBreakdown, SCORE_WEIGHTS, type ScoreInput } from './scoring';

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    usesIndex: true,
    fullScan: false,
    rowsExamined: 10,
    rowsReturned: 10,
    executionTimeMs: 0,
    slowThresholdMs: 100,
    ...over,
  };
}

describe('computeScoreBreakdown', () => {
  it('scores a perfect query 1 across every factor', () => {
    const b = computeScoreBreakdown(input());
    expect(b).toEqual({ indexUsage: 1, selectivity: 1, scanPenalty: 1, latency: 1 });
  });

  it('treats indexUsage as binary', () => {
    expect(computeScoreBreakdown(input({ usesIndex: true })).indexUsage).toBe(1);
    expect(computeScoreBreakdown(input({ usesIndex: false })).indexUsage).toBe(0);
  });

  it('applies the scan penalty only when a full/collection scan happened', () => {
    expect(computeScoreBreakdown(input({ fullScan: false })).scanPenalty).toBe(1);
    expect(computeScoreBreakdown(input({ fullScan: true })).scanPenalty).toBe(0);
  });

  it('computes selectivity as returned/examined, capped at 1', () => {
    expect(computeScoreBreakdown(input({ rowsExamined: 1000, rowsReturned: 10 })).selectivity).toBe(0.01);
    // More returned than examined (estimate noise) must not exceed 1.
    expect(computeScoreBreakdown(input({ rowsExamined: 5, rowsReturned: 50 })).selectivity).toBe(1);
  });

  it('treats zero rows examined as perfectly selective (avoids divide-by-zero)', () => {
    expect(computeScoreBreakdown(input({ rowsExamined: 0, rowsReturned: 0 })).selectivity).toBe(1);
  });

  it('decays latency linearly to 0 at the slow threshold and clamps below', () => {
    expect(computeScoreBreakdown(input({ executionTimeMs: 0, slowThresholdMs: 100 })).latency).toBe(1);
    expect(computeScoreBreakdown(input({ executionTimeMs: 50, slowThresholdMs: 100 })).latency).toBe(0.5);
    expect(computeScoreBreakdown(input({ executionTimeMs: 100, slowThresholdMs: 100 })).latency).toBe(0);
    // Past the threshold the factor floors at 0 rather than going negative.
    expect(computeScoreBreakdown(input({ executionTimeMs: 500, slowThresholdMs: 100 })).latency).toBe(0);
  });

  it('guards against a non-positive slow threshold', () => {
    // slowThresholdMs is divided by max(1, threshold), so 0 must not blow up.
    const b = computeScoreBreakdown(input({ executionTimeMs: 0, slowThresholdMs: 0 }));
    expect(b.latency).toBe(1);
  });
});

describe('computeScore', () => {
  it('returns 100 for a perfect query', () => {
    expect(computeScore(input())).toBe(100);
  });

  it('returns 0 for the worst query (no index, full scan, slow, unselective)', () => {
    const score = computeScore(
      input({ usesIndex: false, fullScan: true, rowsExamined: 1, rowsReturned: 0, executionTimeMs: 1000 }),
    );
    expect(score).toBe(0);
  });

  it('rounds the weighted blend to a 0–100 integer', () => {
    // Index used (0.4) + perfectly selective (0.25) + scan penalty (0.2),
    // but latency at half the threshold contributes 0.15 * 0.5 = 0.075.
    const score = computeScore(input({ executionTimeMs: 50 }));
    expect(score).toBe(Math.round((0.4 + 0.25 + 0.2 + 0.15 * 0.5) * 100));
    expect(Number.isInteger(score)).toBe(true);
  });

  it('weights index usage as the single largest factor', () => {
    const withIndex = computeScore(input({ usesIndex: true }));
    const withoutIndex = computeScore(input({ usesIndex: false }));
    expect(withIndex - withoutIndex).toBe(Math.round(SCORE_WEIGHTS.indexUsage * 100));
  });

  it('always stays within [0, 100]', () => {
    const cases: ScoreInput[] = [
      input(),
      input({ usesIndex: false, fullScan: true, executionTimeMs: 99999 }),
      input({ rowsExamined: 1_000_000, rowsReturned: 1 }),
      input({ executionTimeMs: 100, slowThresholdMs: 100 }),
    ];
    for (const c of cases) {
      const s = computeScore(c);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe('SCORE_WEIGHTS', () => {
  it('sums to 1 so the score spans the full 0–100 range', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});
