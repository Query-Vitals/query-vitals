import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '@renderer/shared/lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-muted border border-accent/60 shadow-glass',
  secondary: 'glass-well text-slate-100 hover:bg-white/10 hover:border-glass-highlight',
  ghost: 'bg-transparent text-slate-300 hover:bg-white/5 border border-transparent',
  danger: 'bg-bad/15 text-bad hover:bg-bad/25 border border-bad/40',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading,
  disabled,
  className,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-all',
        'focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}
