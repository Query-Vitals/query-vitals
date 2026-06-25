/**
 * Presentation helpers for connection tags + colors.
 *
 * Colors are a small curated palette that reads well on the dark theme; we
 * store the hex string on the connection so the UI can tint cards and tag
 * chips without relying on dynamic Tailwind class names (which Tailwind cannot
 * generate at build time for arbitrary values).
 */

import type { CSSProperties } from 'react';

export interface ConnectionColor {
  /** Stable key, handy for keys/labels. */
  key: string;
  /** Human-readable name shown in the picker tooltip. */
  label: string;
  /** Hex value persisted on the connection and used for inline styles. */
  hex: string;
}

export const CONNECTION_COLORS: ConnectionColor[] = [
  { key: 'blue', label: 'Blue', hex: '#5b8def' },
  { key: 'green', label: 'Green', hex: '#3fb950' },
  { key: 'amber', label: 'Amber', hex: '#d29922' },
  { key: 'red', label: 'Red', hex: '#f85149' },
  { key: 'purple', label: 'Purple', hex: '#a371f7' },
  { key: 'cyan', label: 'Cyan', hex: '#39c5cf' },
  { key: 'pink', label: 'Pink', hex: '#db61a2' },
  { key: 'slate', label: 'Slate', hex: '#8b949e' },
];

/** Common environment names offered as one-tap tag suggestions. */
export const SUGGESTED_TAGS = ['production', 'staging', 'development', 'test'] as const;

/**
 * Inline style for a colored chip/badge given a hex color. Uses translucent
 * fill + border so it sits nicely on the dark surface.
 */
export function tagChipStyle(hex: string | undefined): CSSProperties {
  if (!hex) {
    // Neutral slate chip when no color is chosen.
    return { color: '#cbd5e1', backgroundColor: '#252c40', borderColor: '#252c40' };
  }
  return {
    color: hex,
    backgroundColor: `${hex}22`,
    borderColor: `${hex}66`,
  };
}

/** Normalize free-text tag input into a clean, de-duplicated list. */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
