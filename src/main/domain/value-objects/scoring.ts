/**
 * Performance score (0–100). Pure function, easy to unit-test.
 *
 * The score blends four normalized factors so a single number summarizes
 * query health for the detail screen and dashboard:
 *   - indexUsage   : 1 if an index was used, else 0
 *   - selectivity  : rowsReturned / rowsExamined (capped at 1)
 *   - scanPenalty  : 0 if a full/collection scan happened, else 1
 *   - latency      : 1 at 0ms, decaying toward 0 past the slow threshold
 *
 * Weights are intentionally explicit so they can be tuned with real data.
 */

import type { ScoreBreakdown } from '@shared/types/query';

export const SCORE_WEIGHTS = {
  indexUsage: 0.4,
  selectivity: 0.25,
  scanPenalty: 0.2,
  latency: 0.15,
} as const;

export interface ScoreInput {
  usesIndex: boolean;
  fullScan: boolean;
  rowsExamined: number;
  rowsReturned: number;
  executionTimeMs: number;
  slowThresholdMs: number;
}

export function computeScoreBreakdown(input: ScoreInput): ScoreBreakdown {
  const selectivity =
    input.rowsExamined > 0 ? Math.min(1, input.rowsReturned / input.rowsExamined) : 1;
  const latency = Math.max(0, 1 - input.executionTimeMs / Math.max(1, input.slowThresholdMs));
  return {
    indexUsage: input.usesIndex ? 1 : 0,
    selectivity,
    scanPenalty: input.fullScan ? 0 : 1,
    latency: Math.min(1, latency),
  };
}

export function computeScore(input: ScoreInput): number {
  const b = computeScoreBreakdown(input);
  const raw =
    b.indexUsage * SCORE_WEIGHTS.indexUsage +
    b.selectivity * SCORE_WEIGHTS.selectivity +
    b.scanPenalty * SCORE_WEIGHTS.scanPenalty +
    b.latency * SCORE_WEIGHTS.latency;
  return Math.round(raw * 100);
}
