import type { ReactNode } from 'react';
import { cx } from '@renderer/shared/lib/format';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface Column<T> {
  /** Stable key for the column. */
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  /** Optional extra classes for the cell + header (alignment, width). */
  className?: string;
  align?: 'left' | 'right' | 'center';
  /** When true, the header is clickable to sort by this column. */
  sortable?: boolean;
}

interface TableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  className?: string;
  /** Current sort state (controlled). Only affects header indicators. */
  sort?: SortState | undefined;
  /** Called with the column key when a sortable header is clicked. */
  onSortChange?: (key: string) => void;
}

const ALIGN: Record<string, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  className,
  sort,
  onSortChange,
}: TableProps<T>): JSX.Element {
  return (
    <div className={cx('glass-panel overflow-auto rounded-glass', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-glass-border bg-white/5">
            {columns.map((col) => {
              const sortable = col.sortable === true && onSortChange != null;
              const active = sortable && sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  aria-sort={
                    active ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cx(
                    'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400',
                    ALIGN[col.align ?? 'left'],
                    col.className,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange?.(col.key)}
                      className={cx(
                        'inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-slate-200',
                        col.align === 'right' && 'flex-row-reverse',
                        active && 'text-slate-100',
                      )}
                    >
                      <span>{col.header}</span>
                      <span aria-hidden className="text-[0.6rem] leading-none">
                        {active ? (sort?.direction === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-slate-500">
                {empty ?? 'No rows.'}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                role={onRowClick ? 'button' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={cx(
                  'border-b border-glass-border/60 last:border-0',
                  onRowClick &&
                    'cursor-pointer transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cx('px-3 py-2 text-slate-200', ALIGN[col.align ?? 'left'], col.className)}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
