import { useMemo } from 'react';
import type { WorkloadInsight } from '@shared/types/workload';
import type { RecommendationSeverity } from '@shared/types/recommendation';
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
import { getApi, useApi } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';
import {
  formatMs,
  formatNumber,
  prettySql,
  severityVariant,
  severityWeight,
  workloadKindLabel,
  workloadKindVariant,
} from '@renderer/shared/lib/format';

const SEVERITY_ORDER: RecommendationSeverity[] = ['critical', 'high', 'medium', 'low'];

export default function WorkloadScreen(): JSX.Element {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const cid = activeConnectionId ?? '';

  const { data, loading, error, reload } = useApi<WorkloadInsight[]>(
    async () => {
      const api = getApi();
      if (!api || !cid) return [];
      return api.workload.list(cid);
    },
    [cid],
    { enabled: !!cid },
  );

  const grouped = useMemo(() => {
    const insights = data ?? [];
    const map = new Map<RecommendationSeverity, WorkloadInsight[]>();
    for (const sev of SEVERITY_ORDER) map.set(sev, []);
    for (const i of insights) map.get(i.severity)?.push(i);
    return SEVERITY_ORDER.map((severity) => ({ severity, items: map.get(severity) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [data]);

  if (!activeConnectionId) {
    return (
      <EmptyState
        title="No active connection"
        description="Select a connection to view its workload pattern insights."
      />
    );
  }

  const total = (data ?? []).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Workload Insights</h1>
          <p className="text-xs text-slate-400">
            {total} repeated-lookup {total === 1 ? 'pattern' : 'patterns'} across recent activity
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reload}>
          Refresh
        </Button>
      </div>

      <p className="max-w-3xl text-xs text-slate-500">
        Problems that only appear across a burst of queries — many individually-fast lookups that
        add up to a slow page or request. These are query-orchestration issues (batching, joins,
        preloading), kept separate from index suggestions.
      </p>

      {error != null && <ErrorBanner message={`Failed to load insights: ${error}`} />}

      {loading ? (
        <Loading />
      ) : total === 0 ? (
        <EmptyState
          title="No workload patterns detected"
          description="Repeated point-lookup bursts (N+1 patterns) will appear here as monitoring captures query activity."
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
                {group.items.map((insight) => (
                  <InsightCard key={insight.id} insight={insight} />
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function InsightCard({ insight }: { insight: WorkloadInsight }): JSX.Element {
  const code =
    insight.engine === 'mysql' ? prettySql(insight.normalizedQuery) : insight.normalizedQuery;
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={workloadKindVariant(insight.kind)}>
                {workloadKindLabel(insight.kind)}
              </Badge>
              <span className="font-mono text-sm text-slate-200">{insight.targetName}</span>
              <span className="text-xs text-slate-500">{insight.databaseName}</span>
              {insight.usesIndex ? (
                <Badge variant="warn">indexed but repeated</Badge>
              ) : (
                <Badge variant="bad">not indexed</Badge>
              )}
              {insight.batchingCandidate && <Badge variant="good">batching candidate</Badge>}
            </div>
            <p className="mt-2 text-sm font-medium text-slate-100">{insight.title}</p>
            <p className="mt-1 text-xs text-slate-300">{insight.rationale}</p>
            <p className="mt-1 text-xs text-good">Fix: {insight.remediation}</p>
          </div>
        </div>

        <Stats insight={insight} />

        <CodeBlock code={code} copyable maxHeightClass="max-h-32" />
      </CardBody>
    </Card>
  );
}

function Stats({ insight }: { insight: WorkloadInsight }): JSX.Element {
  const items: { label: string; value: string }[] = [
    { label: 'Executions', value: formatNumber(insight.executionCount) },
    { label: 'Window', value: formatMs(insight.windowMs) },
    { label: 'Cumulative', value: formatMs(insight.cumulativeTimeMs) },
    { label: 'Avg / query', value: formatMs(insight.avgExecutionTimeMs) },
    { label: 'Rows examined', value: formatNumber(insight.rowsExamined) },
  ];
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-base-700 bg-base-700 sm:grid-cols-5">
      {items.map((it) => (
        <div key={it.label} className="bg-base-800 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{it.label}</div>
          <div className="font-mono text-sm text-slate-100">{it.value}</div>
        </div>
      ))}
    </div>
  );
}
