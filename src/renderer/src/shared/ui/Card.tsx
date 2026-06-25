import type { CSSProperties, ReactNode } from 'react';
import { cx } from '@renderer/shared/lib/format';

interface CardProps {
  children: ReactNode;
  className?: string;
  /** Adds hover affordance + pointer cursor. */
  interactive?: boolean;
  onClick?: () => void;
  /** Inline styles, e.g. a colored left accent border. */
  style?: CSSProperties | undefined;
}

export function Card({ children, className, interactive, onClick, style }: CardProps): JSX.Element {
  const clickable = onClick != null;
  return (
    <div
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      style={style}
      className={cx(
        'glass-panel rounded-glass',
        interactive &&
          'cursor-pointer transition-all hover:border-glass-highlight hover:bg-base-700/70 hover:shadow-glass-hover',
        clickable &&
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, subtitle, actions }: CardHeaderProps): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-glass-border px-4 py-3">
      <div>
        <div className="text-sm font-semibold text-slate-100">{title}</div>
        {subtitle != null && <div className="mt-0.5 text-xs text-slate-400">{subtitle}</div>}
      </div>
      {actions != null && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cx('px-4 py-3', className)}>{children}</div>;
}
