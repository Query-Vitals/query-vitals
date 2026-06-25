import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '@renderer/shared/lib/format';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function Input({ label, hint, error, className, id, ...rest }: InputProps): JSX.Element {
  return (
    <label className="block">
      {label != null && (
        <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      )}
      <input
        id={id}
        {...rest}
        className={cx(
          'glass-well h-9 w-full rounded-lg px-3 text-sm text-slate-100 placeholder:text-slate-500',
          'focus:outline-none focus:ring-1 focus:ring-accent',
          error ? 'border-bad' : false,
          className,
        )}
      />
      {error != null ? (
        <span className="mt-1 block text-xs text-bad">{error}</span>
      ) : (
        hint != null && <span className="mt-1 block text-xs text-slate-500">{hint}</span>
      )}
    </label>
  );
}
