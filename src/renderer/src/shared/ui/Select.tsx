import type { ReactNode, SelectHTMLAttributes } from 'react';
import { cx } from '@renderer/shared/lib/format';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  options: SelectOption[];
}

export function Select({ label, options, className, id, ...rest }: SelectProps): JSX.Element {
  return (
    <label className="block">
      {label != null && (
        <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      )}
      <select
        id={id}
        {...rest}
        className={cx(
          'glass-well h-9 w-full rounded-lg px-2.5 text-sm text-slate-100',
          'focus:outline-none focus:ring-1 focus:ring-accent',
          className,
        )}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
