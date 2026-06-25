import type { ReactNode } from 'react';
import { cx } from '@renderer/shared/lib/format';

export function Spinner({ className }: { className?: string }): JSX.Element {
  return (
    <span
      className={cx(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-transparent',
        className,
      )}
    />
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorBanner({ message, children }: { message: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad backdrop-blur-glass">
      <span>{message}</span>
      {children}
    </div>
  );
}
