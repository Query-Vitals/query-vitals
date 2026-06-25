import { useMemo, useState } from 'react';
import type {
  Recommendation,
  RecommendationSeverity,
} from '@shared/types/recommendation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CodeBlock,
  EmptyState,
  ErrorBanner,
  Loading,
} from '@renderer/shared/ui';
import { getApi, useApi, useMutation } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';
import {
  cx,
  kindAction,
  kindVariant,
  severityVariant,
  severityWeight,
  type RecommendationAction,
} from '@renderer/shared/lib/format';

const SEVERITY_ORDER: RecommendationSeverity[] = ['critical', 'high', 'medium', 'low'];

const TABS: { action: RecommendationAction; label: string; hint: string }[] = [
  { action: 'add', label: 'Add indexes', hint: 'Create indexes to speed up queries' },
  { action: 'cleanup', label: 'Cleanup', hint: 'Drop unused or redundant indexes' },
];

export default function SuggestionsScreen(): JSX.Element {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const cid = activeConnectionId ?? '';
  const dismiss = useMutation();
  const [tab, setTab] = useState<RecommendationAction>('add');

  const { data, loading, error, reload, setData } = useApi<Recommendation[]>(
    async () => {
      const api = getApi();
      if (!api || !cid) return [];
      return api.recommendations.list(cid);
    },
    [cid],
    { enabled: !!cid },
  );

  const active = useMemo(() => (data ?? []).filter((r) => !r.dismissed), [data]);

  const counts = useMemo(() => {
    const c: Record<RecommendationAction, number> = { add: 0, cleanup: 0 };
    for (const r of active) c[kindAction(r.kind)] += 1;
    return c;
  }, [active]);

  const grouped = useMemo(() => {
    const recs = active.filter((r) => kindAction(r.kind) === tab);
    const map = new Map<RecommendationSeverity, Recommendation[]>();
    for (const sev of SEVERITY_ORDER) map.set(sev, []);
    for (const r of recs) map.get(r.severity)?.push(r);
    return SEVERITY_ORDER.map((sev) => ({ severity: sev, items: map.get(sev) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [active, tab]);

  const onDismiss = async (rec: Recommendation): Promise<void> => {
    const api = getApi();
    if (!api) return;
    // Optimistic removal.
    setData((prev) => (prev ?? []).filter((r) => r.id !== rec.id));
    const ok = await dismiss.run(() => api.recommendations.dismiss(rec.id));
    if (ok === undefined) reload(); // revert on failure
  };

  if (!activeConnectionId) {
    return (
      <EmptyState
        title="No active connection"
        description="Select a connection to view its index recommendations."
      />
    );
  }

  const total = counts.add + counts.cleanup;
  const tabTotal = grouped.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Suggestions</h1>
          <p className="text-xs text-slate-400">
            {total} active {total === 1 ? 'recommendation' : 'recommendations'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reload}>
          Refresh
        </Button>
      </div>

      {error != null && <ErrorBanner message={`Failed to load recommendations: ${error}`} />}

      <div className="flex gap-1 border-b border-base-600">
        {TABS.map((t) => {
          const isActive = tab === t.action;
          return (
            <button
              key={t.action}
              type="button"
              onClick={() => setTab(t.action)}
              title={t.hint}
              className={cx(
                '-mb-px flex items-center gap-2 rounded-t border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                isActive
                  ? 'border-accent text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200',
              )}
            >
              {t.label}
              <span
                className={cx(
                  'rounded-full px-1.5 py-0.5 text-xs',
                  isActive ? 'bg-accent/20 text-accent' : 'bg-base-700 text-slate-400',
                )}
              >
                {counts[t.action]}
              </span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <Loading />
      ) : tabTotal === 0 ? (
        <EmptyState
          title={tab === 'add' ? 'No indexes to add' : 'Nothing to clean up'}
          description={
            tab === 'add'
              ? 'Missing or composite index suggestions will appear here as queries are analyzed.'
              : 'Unused or redundant indexes will appear here as queries are analyzed.'
          }
        />
      ) : (
        <div className="space-y-5">
          {grouped
            .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
            .map((group) => (
              <div key={group.severity} className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant={severityVariant(group.severity)}>{group.severity}</Badge>
                  <span className="text-xs text-slate-500">{group.items.length}</span>
                </div>
                {group.items.map((rec) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    onDismiss={() => void onDismiss(rec)}
                    dismissing={dismiss.loading}
                  />
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function RecommendationCard({
  rec,
  onDismiss,
  dismissing,
}: {
  rec: Recommendation;
  onDismiss: () => void;
  dismissing: boolean;
}): JSX.Element {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={kindVariant(rec.kind)}>{rec.kind}</Badge>
              <span className="font-mono text-sm text-slate-200">{rec.targetName}</span>
              <span className="text-xs text-slate-500">{rec.databaseName}</span>
            </div>
            <p className="mt-2 text-xs text-slate-300">{rec.rationale}</p>
            {rec.estimatedImpact && (
              <p className="mt-1 text-xs text-good">Impact: {rec.estimatedImpact}</p>
            )}
            {rec.fields.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {rec.fields.map((f) => (
                  <span
                    key={f.name}
                    className="rounded border border-base-600 bg-base-700 px-1.5 py-0.5 font-mono text-xs text-slate-300"
                  >
                    {f.name} {f.direction === 1 ? '↑' : '↓'}
                  </span>
                ))}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onDismiss} loading={dismissing}>
            Dismiss
          </Button>
        </div>
        <CodeBlock code={rec.ddl} copyable maxHeightClass="max-h-32" />
      </CardBody>
    </Card>
  );
}
