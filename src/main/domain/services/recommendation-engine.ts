/**
 * IRecommendationEngine — derives index recommendations from analyzed queries
 * plus the set of existing indexes.
 *
 * MySQL: missing index, composite index (column ordering by equality →
 *   range → sort), redundant index (prefix duplicates).
 * MongoDB: missing index, compound index, unused index ($indexStats == 0).
 *
 * The engine is pure: given the same inputs it returns the same suggestions,
 * which makes it straightforward to unit-test.
 */

import type { Recommendation } from '@shared/types/recommendation';
import type { QueryRecord } from '@shared/types/query';
import type { ExistingIndex } from './database-connector';

export interface RecommendationInput {
  connectionId: string;
  /** Analyzed query digests for the connection. */
  queries: QueryRecord[];
  /** Current indexes, keyed implicitly by db/target. */
  existingIndexes: ExistingIndex[];
}

export interface IRecommendationEngine {
  /** Suggest indexes that would eliminate scans / poor selectivity. */
  suggestMissingIndexes(input: RecommendationInput): Recommendation[];

  /** Merge single-column candidates into ordered composite/compound indexes. */
  suggestCompositeIndexes(input: RecommendationInput): Recommendation[];

  /** Flag duplicate or prefix-redundant indexes (MySQL). */
  detectRedundantIndexes(input: RecommendationInput): Recommendation[];

  /** Flag indexes never used over the observation window (MongoDB). */
  detectUnusedIndexes(input: RecommendationInput): Recommendation[];

  /** Run all rule sets and return a de-duplicated, severity-sorted list. */
  generateAll(input: RecommendationInput): Recommendation[];
}
