/**
 * Parses MySQL `EXPLAIN FORMAT=JSON` output into the engine-agnostic
 * ExecutionPlanNode tree + IndexAnalysis. Pure and unit-testable.
 *
 * Note: EXPLAIN figures are the optimizer's *estimates*. They are accurate
 * enough to detect index usage and full scans, which is what the analysis
 * cares about; exact counts come from performance_schema on the collector path.
 */

import type { ExecutionPlanNode, IndexAnalysis } from '@shared/types/query';
import { computeScore, computeScoreBreakdown } from '@main/domain/value-objects/scoring';

interface TableInfo {
  table_name?: string;
  access_type?: string;
  key?: string | null;
  possible_keys?: string[] | null;
  rows_examined_per_scan?: number;
  rows_produced_per_join?: number;
  filtered?: string | number;
  used_key_parts?: string[];
}

const FULL_SCAN_TYPES = new Set(['ALL']);
const INDEX_TYPES = new Set(['system', 'const', 'eq_ref', 'ref', 'fulltext', 'ref_or_null', 'range', 'index_merge', 'index', 'unique_subquery', 'index_subquery']);

export function parseMySqlExplain(
  rawJson: string,
  executionTimeMs: number,
  slowThresholdMs = 100,
): { plan: ExecutionPlanNode; rawPlan: unknown; analysis: IndexAnalysis } {
  const rawPlan: unknown = JSON.parse(rawJson);
  const tables: TableInfo[] = [];
  collectTables(rawPlan, tables);

  const indexesUsed = tables
    .map((t) => t.key)
    .filter((k): k is string => typeof k === 'string' && k.length > 0);

  const fullTableScan = tables.some((t) => t.access_type && FULL_SCAN_TYPES.has(t.access_type));
  const usesIndex =
    indexesUsed.length > 0 ||
    tables.some((t) => t.access_type != null && INDEX_TYPES.has(t.access_type));

  const rowsExamined = tables.reduce((sum, t) => sum + (Number(t.rows_examined_per_scan) || 0), 0);
  const rowsReturned =
    tables.length > 0
      ? Number(tables[tables.length - 1]?.rows_produced_per_join) ||
        Number(tables[0]?.rows_produced_per_join) ||
        0
      : 0;
  const selectivity = rowsExamined > 0 ? Math.min(1, rowsReturned / rowsExamined) : 1;

  const scoreInput = {
    usesIndex,
    fullScan: fullTableScan,
    rowsExamined,
    rowsReturned,
    executionTimeMs,
    slowThresholdMs,
  };

  const plan = buildPlanTree(rawPlan);
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

/** Walk the EXPLAIN JSON collecting every `table` object. */
function collectTables(node: unknown, out: TableInfo[]): void {
  if (node == null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj['table'] && typeof obj['table'] === 'object') {
    out.push(obj['table'] as TableInfo);
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach((v) => collectTables(v, out));
    else if (value && typeof value === 'object') collectTables(value, out);
  }
}

/** Produce a readable plan tree (one node per table access). */
function buildPlanTree(rawPlan: unknown): ExecutionPlanNode {
  const tables: TableInfo[] = [];
  collectTables(rawPlan, tables);
  const children: ExecutionPlanNode[] = tables.map((t) => ({
    stage: t.access_type ?? 'unknown',
    ...(t.table_name ? { target: t.table_name } : {}),
    ...(t.key ? { indexName: t.key } : {}),
    ...(t.rows_examined_per_scan != null
      ? { rowsExamined: Number(t.rows_examined_per_scan) }
      : {}),
    ...(t.rows_produced_per_join != null
      ? { rowsReturned: Number(t.rows_produced_per_join) }
      : {}),
    detail: describeAccess(t),
  }));
  return {
    stage: 'query_block',
    detail: 'MySQL execution plan (optimizer estimates)',
    children,
  };
}

function describeAccess(t: TableInfo): string {
  switch (t.access_type) {
    case 'ALL':
      return `Full table scan of ${t.table_name ?? 'table'} — no index used`;
    case 'index':
      return `Full index scan using ${t.key ?? 'an index'}`;
    case 'range':
      return `Range scan on ${t.key ?? 'an index'}`;
    case 'ref':
    case 'eq_ref':
      return `Index lookup on ${t.key ?? 'an index'}`;
    case 'const':
    case 'system':
      return `Single-row constant lookup on ${t.key ?? 'primary key'}`;
    default:
      return `${t.access_type ?? 'access'} on ${t.table_name ?? 'table'}`;
  }
}
