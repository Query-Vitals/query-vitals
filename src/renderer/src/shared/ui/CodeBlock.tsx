import { useState } from 'react';
import { cx } from '@renderer/shared/lib/format';

interface CodeBlockProps {
  code: string;
  /** Show a copy-to-clipboard button in the top-right. */
  copyable?: boolean;
  className?: string;
  /** Constrain height and scroll. */
  maxHeightClass?: string;
}

export function CodeBlock({
  code,
  copyable = false,
  className,
  maxHeightClass = 'max-h-80',
}: CodeBlockProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const onCopy = (): void => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className={cx('relative', className)}>
      {copyable && (
        <button
          onClick={onCopy}
          className="glass-well absolute right-2 top-2 z-10 rounded-full px-2 py-0.5 text-xs text-slate-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
      <pre
        className={cx(
          'glass-well overflow-auto rounded-lg p-3',
          maxHeightClass,
        )}
      >
        <code className="font-mono text-xs leading-relaxed text-slate-200 whitespace-pre">
          {code}
        </code>
      </pre>
    </div>
  );
}
