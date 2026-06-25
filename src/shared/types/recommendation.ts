/**
 * Index recommendations produced by the recommendation engine.
 * Engine-agnostic in shape; `ddl` carries the engine-specific statement.
 */

import type { DatabaseEngine } from './database';

export type RecommendationKind =
  | 'missing-index'
  | 'composite-index' // MySQL multi-column
  | 'compound-index' // MongoDB multi-field
  | 'redundant-index' // MySQL: prefix-of-another / duplicate
  | 'unused-index'; // MongoDB: defined but never hit

export type RecommendationSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface IndexField {
  name: string;
  /** 1 = ascending, -1 = descending (Mongo); ASC/DESC inferred for MySQL. */
  direction: 1 | -1;
}

export interface Recommendation {
  id: string;
  connectionId: string;
  engine: DatabaseEngine;
  kind: RecommendationKind;
  severity: RecommendationSeverity;

  databaseName: string;
  targetName: string;

  /** Ordered fields for the proposed (or offending) index. */
  fields: IndexField[];

  /** Ready-to-run statement, e.g. CREATE INDEX ... or createIndex({...}). */
  ddl: string;

  /** Why this is recommended, in plain language. */
  rationale: string;
  /** Estimated impact, e.g. "scans 50k rows → ~12 rows". */
  estimatedImpact?: string;

  /** Query fingerprints that motivated this recommendation. */
  sourceFingerprints: string[];
  createdAt: string;
  /** User can dismiss a suggestion so it stops resurfacing. */
  dismissed: boolean;
}
