/**
 * Small pure formatting + presentation helpers shared across screens.
 * No side effects, no window/api access.
 */

import type { QueryType } from '@shared/types/query';
import type { RecommendationKind, RecommendationSeverity } from '@shared/types/recommendation';

export type BadgeVariant = 'good' | 'warn' | 'bad' | 'neutral' | 'accent';

/** Format a millisecond duration into a compact human string. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = s / 60;
  return `${m.toFixed(1)} min`;
}

/** Format an integer count with thousands separators. */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

/** Compact large numbers, e.g. 12345 -> "12.3k". */
export function formatCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

/** Format a 0..1 ratio as a percentage string. */
export function formatPct(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || Number.isNaN(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Format a 0..100 percentage value directly. */
export function formatPctValue(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Format an ISO timestamp into a short local date-time. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Short time-only label for chart axes. */
export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export type ScoreBand = 'good' | 'warn' | 'bad';

/** Map a 0..100 performance score to a qualitative band. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 75) return 'good';
  if (score >= 45) return 'warn';
  return 'bad';
}

/** Hex color (matching tailwind config) for a score band. */
export function scoreColor(score: number): string {
  switch (scoreBand(score)) {
    case 'good':
      return '#3fb950';
    case 'warn':
      return '#d29922';
    case 'bad':
      return '#f85149';
  }
}

/** Badge variant for a score value. */
export function scoreVariant(score: number): BadgeVariant {
  return scoreBand(score);
}

/** Badge variant for a query type, grouping by read/write/other. */
export function queryTypeVariant(type: QueryType): BadgeVariant {
  switch (type) {
    case 'select':
    case 'find':
      return 'accent';
    case 'aggregate':
    case 'count':
      return 'neutral';
    case 'insert':
    case 'update':
    case 'delete':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** Badge variant for a recommendation severity. */
export function severityVariant(severity: RecommendationSeverity): BadgeVariant {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'bad';
    case 'medium':
      return 'warn';
    case 'low':
      return 'neutral';
  }
}

/** Numeric sort weight for severities (higher = more urgent). */
export function severityWeight(severity: RecommendationSeverity): number {
  switch (severity) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
  }
}

/**
 * Action group for a recommendation kind.
 * `add` = create a new index to speed queries; `cleanup` = drop a redundant
 * or unused index. The two are opposite actions and shown in separate tabs.
 */
export type RecommendationAction = 'add' | 'cleanup';

export function kindAction(kind: RecommendationKind): RecommendationAction {
  switch (kind) {
    case 'missing-index':
    case 'composite-index':
    case 'compound-index':
      return 'add';
    case 'redundant-index':
    case 'unused-index':
      return 'cleanup';
  }
}

/** Distinct badge variant per kind so types are visually separable. */
export function kindVariant(kind: RecommendationKind): BadgeVariant {
  switch (kind) {
    case 'missing-index':
      return 'accent';
    case 'composite-index':
    case 'compound-index':
      return 'good';
    case 'unused-index':
      return 'warn';
    case 'redundant-index':
      return 'bad';
  }
}

/** Badge variant for a workload-insight kind. */
export function workloadKindVariant(kind: 'n-plus-one'): BadgeVariant {
  switch (kind) {
    case 'n-plus-one':
      return 'accent';
  }
}

/** Human label for a workload-insight kind. */
export function workloadKindLabel(kind: 'n-plus-one'): string {
  switch (kind) {
    case 'n-plus-one':
      return 'N+1 pattern';
  }
}

/** Truncate a single-line string to a max length with an ellipsis. */
export function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Very basic SQL pretty-printer: uppercases common keywords and inserts line
 * breaks before major clauses. Best-effort only; not a real formatter.
 */
export function prettySql(sql: string): string {
  const clauses = [
    'SELECT',
    'FROM',
    'WHERE',
    'INNER JOIN',
    'LEFT JOIN',
    'RIGHT JOIN',
    'JOIN',
    'GROUP BY',
    'ORDER BY',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'UNION',
    'VALUES',
    'SET',
  ];
  let out = sql.replace(/\s+/g, ' ').trim();
  for (const clause of clauses) {
    const re = new RegExp(`\\s+(${clause.replace(/ /g, '\\s+')})\\s+`, 'gi');
    out = out.replace(re, `\n${clause} `);
  }
  return out.trim();
}

/** Join an array of class names, dropping falsy entries. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
