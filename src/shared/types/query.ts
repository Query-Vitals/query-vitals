/**
 * Engine-agnostic representation of an observed query and its analysis.
 * MySQL EXPLAIN output and MongoDB explain() output are both normalized into
 * these shapes so the UI and recommendation engine stay engine-independent.
 */

import type { DatabaseEngine } from './database';

export type QueryType =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'aggregate' // mongo aggregation pipeline
  | 'find' // mongo find
  | 'count'
  | 'other';

/** How the query was discovered by a collector. */
export type QuerySource =
  | 'mysql.performance_schema'
  | 'mysql.slow_log'
  | 'mongo.profiler'
  | 'mongo.currentOp'
  | 'manual'; // pasted into the analyzer by the user

/**
 * A single observed query execution (or an aggregated digest of many runs of
 * the same normalized statement).
 */
export interface QueryRecord {
  id: string;
  connectionId: string;
  engine: DatabaseEngine;
  source: QuerySource;

  /** Raw statement or command, e.g. SQL text or a Mongo command document. */
  rawQuery: string;
  /**
   * Normalized statement with literals replaced by "?" placeholders.
   * Used as the grouping key for digests (the "query fingerprint").
   */
  normalizedQuery: string;
  fingerprint: string;
  queryType: QueryType;

  databaseName: string;
  /** Table (MySQL) or collection (MongoDB). Multiple for joins/lookups. */
  targetName: string;
  relatedTargets?: string[];

  /** Wall-clock execution time in milliseconds. */
  executionTimeMs: number;
  timestamp: string;

  /** Digest fields — populated when this record aggregates repeated runs. */
  executionCount?: number;
  avgExecutionTimeMs?: number;
  maxExecutionTimeMs?: number;

  analysis?: IndexAnalysis;
}

/** Normalized index-usage verdict derived from the execution plan. */
export interface IndexAnalysis {
  /** True if at least one index was used to satisfy the query. */
  usesIndex: boolean;
  /** MySQL: full table scan (type=ALL). */
  fullTableScan: boolean;
  /** MongoDB: COLLSCAN stage present. */
  collectionScan: boolean;

  indexesUsed: string[];

  rowsExamined: number;
  rowsReturned: number;
  /**
   * Selectivity = rowsReturned / rowsExamined (0..1). Low values mean the
   * engine read far more rows than it returned — a prime tuning target.
   */
  selectivity: number;

  /** Normalized, engine-agnostic plan tree for display. */
  executionPlan: ExecutionPlanNode;
  /** Raw plan JSON exactly as returned by the engine, for power users. */
  rawPlan: unknown;

  /** Composite 0–100 performance score; see scoring.ts for the formula. */
  performanceScore: number;
  scoreBreakdown: ScoreBreakdown;
}

/** A node in the normalized execution plan tree. */
export interface ExecutionPlanNode {
  /** Engine stage label, e.g. "ALL", "ref", "COLLSCAN", "IXSCAN", "FETCH". */
  stage: string;
  target?: string;
  indexName?: string;
  rowsExamined?: number;
  rowsReturned?: number;
  estimatedCost?: number;
  /** Human-readable explanation of what this stage does. */
  detail?: string;
  children?: ExecutionPlanNode[];
}

/** Per-factor contributions to the performance score, each 0..1. */
export interface ScoreBreakdown {
  indexUsage: number;
  selectivity: number;
  scanPenalty: number;
  latency: number;
}
