/**
 * Helpers for feeding normalized SQL to node-sql-parser with the right
 * engine dialect. Normalized queries use "?" placeholders across all engines,
 * but the PostgresQL grammar only accepts $n parameters — so for Postgres the
 * placeholders are re-numbered to $1, $2, … before parsing.
 */

import type { DatabaseEngine } from '@shared/types/database';

export function sqlDialectOf(engine: DatabaseEngine): 'MySQL' | 'PostgresQL' {
  return engine === 'postgres' ? 'PostgresQL' : 'MySQL';
}

/** Rewrite normalized "?" placeholders into a form the dialect can parse. */
export function parseableSql(normalizedQuery: string, engine: DatabaseEngine): string {
  if (engine !== 'postgres') return normalizedQuery;
  let n = 0;
  // Normalization already collapsed string literals, so every remaining "?"
  // is a placeholder — a blind replace cannot corrupt string contents.
  return normalizedQuery.replace(/\?/g, () => `$${++n}`);
}
