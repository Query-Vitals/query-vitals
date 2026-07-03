/**
 * Parses PostgreSQL `EXPLAIN (FORMAT JSON)` output into the engine-agnostic
 * ExecutionPlanNode tree + IndexAnalysis. Pure and unit-testable.
 *
 * PostgreSQL node types (Seq Scan, Index Scan, Index Only Scan, Bitmap
 * Index/Heap Scan, Nested Loop, Hash Join, Merge Join, Sort, …) are kept as
 * stage labels so the detail screen preserves engine-specific evidence, while
 * the analysis reduces them to the shared usesIndex/fullTableScan vocabulary.
 *
 * When the plan came from `EXPLAIN (ANALYZE, BUFFERS)`, actual row counts and
 * shared-buffer figures are used instead of the optimizer's estimates, and
 * buffer hits/reads are surfaced in each node's detail line so cached CPU-heavy
 * work is distinguishable from real I/O pressure.
 */

import type { ExecutionPlanNode, IndexAnalysis } from '@shared/types/query';
import { computeScore, computeScoreBreakdown } from '@main/domain/value-objects/scoring';

/** The subset of a PostgreSQL plan node the parser reads. */
interface PgPlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Sort Key'?: string[];
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  Filter?: string;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PgPlanNode[];
}

interface PgExplainRoot {
  Plan?: PgPlanNode;
  'Execution Time'?: number;
}

/** Node types that read a relation. */
const SCAN_TYPES = new Set([
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Tid Scan',
  'Sample Scan',
]);
const INDEX_SCAN_TYPES = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

export function parsePostgresExplain(
  rawJson: string,
  executionTimeMs: number,
  slowThresholdMs = 100,
): { plan: ExecutionPlanNode; rawPlan: unknown; analysis: IndexAnalysis } {
  const rawPlan: unknown = JSON.parse(rawJson);
  const root = (Array.isArray(rawPlan) ? rawPlan[0] : rawPlan) as PgExplainRoot | undefined;
  const rootNode = root?.Plan ?? {};

  const flat: PgPlanNode[] = [];
  flatten(rootNode, flat);

  const indexesUsed = [
    ...new Set(
      flat
        .filter((n) => n['Node Type'] != null && INDEX_SCAN_TYPES.has(n['Node Type']))
        .map((n) => n['Index Name'])
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    ),
  ];
  const fullTableScan = flat.some((n) => n['Node Type'] === 'Seq Scan');
  const usesIndex = indexesUsed.length > 0;

  const analyzed = flat.some((n) => n['Actual Rows'] != null);
  const rowsExamined = flat
    .filter((n) => n['Node Type'] != null && SCAN_TYPES.has(n['Node Type']))
    .reduce((sum, n) => sum + examinedRows(n, analyzed), 0);
  const rowsReturned = analyzed
    ? (rootNode['Actual Rows'] ?? 0) * (rootNode['Actual Loops'] ?? 1)
    : (rootNode['Plan Rows'] ?? 0);
  const selectivity = rowsExamined > 0 ? Math.min(1, rowsReturned / rowsExamined) : 1;

  // An ANALYZE run reports the true wall-clock time; prefer it when the caller
  // has no observed timing of its own (ad-hoc inspection passes 0).
  const effectiveTimeMs =
    executionTimeMs > 0 ? executionTimeMs : (root?.['Execution Time'] ?? executionTimeMs);

  const scoreInput = {
    usesIndex,
    fullScan: fullTableScan,
    rowsExamined,
    rowsReturned,
    executionTimeMs: effectiveTimeMs,
    slowThresholdMs,
  };

  const plan: ExecutionPlanNode = {
    stage: 'Query Plan',
    detail: analyzed
      ? 'PostgreSQL execution plan (actual figures from ANALYZE)'
      : 'PostgreSQL execution plan (optimizer estimates)',
    children: [buildPlanTree(rootNode, analyzed)],
  };

  const analysis: IndexAnalysis = {
    usesIndex,
    fullTableScan,
    collectionScan: false,
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

/** Rows a scan node actually touched (or is estimated to touch). */
function examinedRows(n: PgPlanNode, analyzed: boolean): number {
  if (analyzed) {
    const loops = n['Actual Loops'] ?? 1;
    const perLoop =
      (n['Actual Rows'] ?? 0) +
      (n['Rows Removed by Filter'] ?? 0) +
      (n['Rows Removed by Index Recheck'] ?? 0);
    return perLoop * loops;
  }
  return n['Plan Rows'] ?? 0;
}

function flatten(node: PgPlanNode, out: PgPlanNode[]): void {
  out.push(node);
  node.Plans?.forEach((child) => flatten(child, out));
}

function buildPlanTree(node: PgPlanNode, analyzed: boolean): ExecutionPlanNode {
  const nodeType = node['Node Type'] ?? 'unknown';
  const rowsReturned = analyzed
    ? (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1)
    : node['Plan Rows'];
  const isScan = SCAN_TYPES.has(nodeType);
  return {
    stage: nodeType,
    ...(node['Relation Name'] ? { target: node['Relation Name'] } : {}),
    ...(node['Index Name'] ? { indexName: node['Index Name'] } : {}),
    ...(isScan ? { rowsExamined: examinedRows(node, analyzed) } : {}),
    ...(rowsReturned != null ? { rowsReturned } : {}),
    ...(node['Total Cost'] != null ? { estimatedCost: node['Total Cost'] } : {}),
    detail: describeNode(node),
    ...(node.Plans?.length
      ? { children: node.Plans.map((child) => buildPlanTree(child, analyzed)) }
      : {}),
  };
}

function describeNode(n: PgPlanNode): string {
  const parts: string[] = [describeAccess(n)];
  if (n['Index Cond']) parts.push(`index cond: ${n['Index Cond']}`);
  if (n['Recheck Cond']) parts.push(`recheck: ${n['Recheck Cond']}`);
  if (n.Filter) parts.push(`filter: ${n.Filter}`);
  if (n['Rows Removed by Filter'] != null && n['Rows Removed by Filter'] > 0) {
    parts.push(`${n['Rows Removed by Filter'].toLocaleString('en-US')} rows removed by filter`);
  }
  const hit = n['Shared Hit Blocks'];
  const read = n['Shared Read Blocks'];
  if (hit != null || read != null) {
    parts.push(`buffers: ${hit ?? 0} hit / ${read ?? 0} read`);
  }
  return parts.join(' · ');
}

function describeAccess(n: PgPlanNode): string {
  const rel = n['Relation Name'] ?? 'relation';
  switch (n['Node Type']) {
    case 'Seq Scan':
      return `Sequential scan of ${rel} — every row is read`;
    case 'Index Scan':
      return `Index scan using ${n['Index Name'] ?? 'an index'}, fetching matching heap rows`;
    case 'Index Only Scan':
      return `Index-only scan using ${n['Index Name'] ?? 'an index'} — answered from the index without heap fetches`;
    case 'Bitmap Index Scan':
      return `Bitmap built from ${n['Index Name'] ?? 'an index'}`;
    case 'Bitmap Heap Scan':
      return `Heap rows fetched via bitmap on ${rel}`;
    case 'Nested Loop':
      return `Nested loop join${n['Join Type'] ? ` (${n['Join Type']})` : ''} — inner side re-executed per outer row`;
    case 'Hash Join':
      return `Hash join${n['Join Type'] ? ` (${n['Join Type']})` : ''}`;
    case 'Merge Join':
      return `Merge join${n['Join Type'] ? ` (${n['Join Type']})` : ''} of pre-sorted inputs`;
    case 'Sort':
      return n['Sort Key']?.length ? `Sort by ${n['Sort Key'].join(', ')}` : 'Sort';
    case 'Hash':
      return 'Hash table build';
    case 'Aggregate':
      return 'Aggregate';
    case 'Limit':
      return 'Limit';
    case 'Gather':
    case 'Gather Merge':
      return 'Parallel worker results gathered';
    default:
      return `${n['Node Type'] ?? 'Operation'}${n['Relation Name'] ? ` on ${rel}` : ''}`;
  }
}
