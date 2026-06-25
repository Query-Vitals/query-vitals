import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-glass border border-dashed border-glass-border bg-white/[0.02] px-6 py-14 text-center backdrop-blur-glass">
      {icon != null && <div className="mb-3 text-slate-500">{icon}</div>}
      <div className="text-sm font-semibold text-slate-200">{title}</div>
      {description != null && (
        <div className="mt-1 max-w-sm text-xs text-slate-400">{description}</div>
      )}
      {action != null && <div className="mt-4">{action}</div>}
    </div>
  );
}
