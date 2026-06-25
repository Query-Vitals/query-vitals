import { cx } from '@renderer/shared/lib/format';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible label; required when no visible label wraps the switch. */
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * macOS-style capsule toggle switch. Renders as a real `role="switch"` button
 * so it is keyboard- and screen-reader-accessible.
 */
export function Switch({
  checked,
  onChange,
  id,
  disabled,
  className,
  'aria-label': ariaLabel,
}: SwitchProps): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-accent/60 bg-accent' : 'glass-well',
        className,
      )}
    >
      <span
        className={cx(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow-glass transition-transform',
          checked ? 'translate-x-5' : 'translate-x-1',
        )}
      />
    </button>
  );
}
