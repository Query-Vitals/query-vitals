import { cx } from '@renderer/shared/lib/format';
import type { ConnectionStatus } from '@shared/types/database';

interface StatusDotProps {
  status: ConnectionStatus | string | undefined;
  /** Render the status label next to the dot. */
  label?: boolean;
  className?: string;
}

const COLOR: Record<string, string> = {
  connected: 'bg-good',
  connecting: 'bg-warn animate-pulse',
  disconnected: 'bg-slate-500',
  error: 'bg-bad',
};

const LABEL: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Disconnected',
  error: 'Error',
};

export function StatusDot({ status, label, className }: StatusDotProps): JSX.Element {
  const key = status ?? 'disconnected';
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)}>
      <span className={cx('h-2 w-2 rounded-full', COLOR[key] ?? 'bg-slate-500')} />
      {label && (
        <span className="text-xs text-slate-400">{LABEL[key] ?? 'Unknown'}</span>
      )}
    </span>
  );
}
