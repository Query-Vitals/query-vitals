import type { ReactNode } from 'react';
import { cx, type BadgeVariant } from '@renderer/shared/lib/format';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const VARIANTS: Record<BadgeVariant, string> = {
  good: 'border-good/40 bg-good/15 text-good',
  warn: 'border-warn/40 bg-warn/15 text-warn',
  bad: 'border-bad/40 bg-bad/15 text-bad',
  accent: 'border-accent-muted bg-accent/15 text-accent',
  neutral: 'border-base-600 bg-base-700 text-slate-300',
};

export function Badge({ children, variant = 'neutral', className }: BadgeProps): JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
