/**
 * Parses MongoDB `explain("executionStats")` output into the engine-agnostic
 * ExecutionPlanNode tree + IndexAnalysis. Pure and unit-testable — the sibling
 * of mysql/explain-parser.ts.
 *
 * Unlike MySQL EXPLAIN (optimizer estimates), executionStats reports the real
 * work the engine did for the run: totalDocsExamined / totalKeysExamined vs.
 * nReturned. We read the *winning* plan's stage tree to decide index usage and
 * collection scans, and the executionStats totals for the examined/returned
 * counts that drive selectivity and the score.
 *
 * Two shapes are handled:
 *   - find / count / update / delete: { queryPlanner.winningPlan, executionStats }
 *   - aggregate: { stages: [ { $cursor: { queryPlanner, executionStats } }, ... ] }
 *     (and the newer top-level queryPlanner form). The parser walks whatever it
 *     is given, so it tolerates either.
 */

import type { ExecutionPlanNode, IndexAnalysis } from '@shared/types/query';
import { computeScore, computeScoreBreakdown } from '@main/domain/value-objects/scoring';

/** A single stage in a Mongo winning-plan tree. */
interface PlanStage {
  stage?: string;
  indexName?: string;
  keyPattern?: Record<string, number>;
  direction?: string;
  isMultiKey?: boolean;
  docsExamined?: number;
  keysExamined?: number;
  nReturned?: number;
  inputStage?: PlanStage;
  inputStages?: PlanStage[];
  [key: string]: unknown;
}

interface ExecutionStats {
  nReturned?: number;
  executionTimeMillis?: number;
  totalKeysExamined?: number;
  totalDocsExamined?: number;
  executionStages?: PlanStage;
}

/** Stages that mean "an index was used to locate documents". */
const INDEX_STAGES = new Set(['IXSCAN', 'COUNT_SCAN', 'DISTINCT_SCAN', 'IDHACK']);
const COLLSCAN = 'COLLSCAN';

export function parseMongoExplain(
  rawPlan: unknown,
  executionTimeMs: number,
  slowThresholdMs = 100,
): { plan: ExecutionPlanNode; rawPlan: unknown; analysis: IndexAnalysis } {
  const winningPlan = findWinningPlan(rawPlan);
  const execStats = findExecutionStats(rawPlan);

  const stages: PlanStage[] = [];
  if (winningPlan) collectStages(winningPlan, stages);
  // Fall back to the executionStages tree if no queryPlanner was present.
  if (!stages.length && execStats?.executionStages) collectStages(execStats.executionStages, stages);

  const indexesUsed = stages
    .map((s) => s.indexName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

  const collectionScan = stages.some((s) => s.stage === COLLSCAN);
  const usesIndex =
    indexesUsed.length > 0 || stages.some((s) => s.stage != null && INDEX_STAGES.has(s.stage));

  const totalDocs = Number(execStats?.totalDocsExamined ?? 0);
  const totalKeys = Number(execStats?.totalKeysExamined ?? 0);
  // Examined = the work actually done. Covered queries touch 0 docs but N keys,
  // so take whichever is larger to avoid understating the cost.
  const rowsExamined = Math.max(totalDocs, totalKeys);
  const rowsReturned = Number(execStats?.nReturned ?? 0);
  const selectivity = rowsExamined > 0 ? Math.min(1, rowsReturned / rowsExamined) : 1;

  // Prefer the engine-reported time when the caller didn't observe one.
  const effectiveTimeMs =
    executionTimeMs > 0 ? executionTimeMs : Number(execStats?.executionTimeMillis ?? 0);

  const scoreInput = {
    usesIndex,
    // Mongo's scan penalty is the collection scan; there is no "full table scan".
    fullScan: collectionScan,
    rowsExamined,
    rowsReturned,
    executionTimeMs: effectiveTimeMs,
    slowThresholdMs,
  };

  const plan = buildPlanTree(winningPlan ?? execStats?.executionStages ?? null);
  const analysis: IndexAnalysis = {
    usesIndex,
    fullTableScan: false,
    collectionScan,
    indexesUsed,
    rowsExamined,
    rowsReturned,
    selectivity,
    executionPlan: plan,
    rawPlan,
    performanceScore: computeScore(scoreInput),
    scoreBreakdown: computeScoreBreakdown(scoreInput),
  };
  return { plan, rawPlan, analysis };
}

/** Depth-first search for the first `winningPlan` object anywhere in the doc. */
function findWinningPlan(node: unknown): PlanStage | null {
  if (node == null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (obj['winningPlan'] && typeof obj['winningPlan'] === 'object') {
    return obj['winningPlan'] as PlanStage;
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        const found = findWinningPlan(v);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findWinningPlan(value);
      if (found) return found;
    }
  }
  return null;
}

/** DFS for the first `executionStats` object (find or aggregate $cursor). */
function findExecutionStats(node: unknown): ExecutionStats | null {
  if (node == null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (obj['executionStats'] && typeof obj['executionStats'] === 'object') {
    return obj['executionStats'] as ExecutionStats;
  }
  // Some aggregate explains expose nReturned/totalDocsExamined at this level.
  if ('totalDocsExamined' in obj || 'totalKeysExamined' in obj) {
    return obj as ExecutionStats;
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        const found = findExecutionStats(v);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findExecutionStats(value);
      if (found) return found;
    }
  }
  return null;
}

/** Flatten a winning-plan tree into a list of stages (inputStage/inputStages). */
function collectStages(stage: PlanStage, out: PlanStage[]): void {
  if (!stage || typeof stage !== 'object') return;
  out.push(stage);
  if (stage.inputStage) collectStages(stage.inputStage, out);
  if (Array.isArray(stage.inputStages)) {
    for (const child of stage.inputStages) collectStages(child, out);
  }
}

/** Build a readable, nested plan tree from a Mongo stage tree. */
function buildPlanTree(stage: PlanStage | null): ExecutionPlanNode {
  if (!stage) {
    return { stage: 'unknown', detail: 'No execution plan returned by MongoDB' };
  }
  return toNode(stage);
}

function toNode(stage: PlanStage): ExecutionPlanNode {
  const children: ExecutionPlanNode[] = [];
  if (stage.inputStage) children.push(toNode(stage.inputStage));
  if (Array.isArray(stage.inputStages)) {
    for (const child of stage.inputStages) children.push(toNode(child));
  }
  const node: ExecutionPlanNode = {
    stage: stage.stage ?? 'unknown',
    detail: describeStage(stage),
  };
  if (stage.indexName) node.indexName = stage.indexName;
  if (stage.docsExamined != null) node.rowsExamined = Number(stage.docsExamined);
  else if (stage.keysExamined != null) node.rowsExamined = Number(stage.keysExamined);
  if (stage.nReturned != null) node.rowsReturned = Number(stage.nReturned);
  if (children.length) node.children = children;
  return node;
}

function describeStage(stage: PlanStage): string {
  const idx = stage.indexName ? `\`${stage.indexName}\`` : 'an index';
  const keys = stage.keyPattern ? ` (${Object.keys(stage.keyPattern).join(', ')})` : '';
  switch (stage.stage) {
    case COLLSCAN:
      return 'Collection scan — every document is read, no index used';
    case 'IXSCAN':
      return `Index scan using ${idx}${keys}`;
    case 'COUNT_SCAN':
      return `Counting through index ${idx}`;
    case 'DISTINCT_SCAN':
      return `Distinct scan over index ${idx}`;
    case 'IDHACK':
      return 'Fast _id lookup';
    case 'FETCH':
      return 'Fetch the full documents for the matched index entries';
    case 'SORT':
      return 'In-memory sort — the result is not ordered by an index';
    case 'SORT_KEY_GENERATOR':
      return 'Generate sort keys for an in-memory sort';
    case 'PROJECTION_COVERED':
      return 'Covered projection — served entirely from the index, no FETCH';
    case 'PROJECTION_SIMPLE':
    case 'PROJECTION_DEFAULT':
      return 'Projection of selected fields';
    case 'LIMIT':
      return 'Limit the number of results';
    case 'SKIP':
      return 'Skip leading results';
    default:
      return `${stage.stage ?? 'stage'}`;
  }
}
