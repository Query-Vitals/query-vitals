import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ExecutionPlanNode, QueryRecord, ScoreBreakdown } from '@shared/types/query';
import type { Recommendation } from '@shared/types/recommendation';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  EmptyState,
  ErrorBanner,
  Loading,
  ScoreRing,
} from '@renderer/shared/ui';
import { getApi, useMutation } from '@renderer/shared/hooks/useApi';
import {
  formatMs,
  formatNumber,
  formatPct,
  prettySql,
  queryTypeVariant,
} from '@renderer/shared/lib/format';

export default function QueryDetailScreen(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [record, setRecord] = useState<QueryRecord | null | undefined>(undefined);
  const [recommendation, setRecommendation] = useState<Recommendation | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const explain = useMutation();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const api = getApi();
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const rec = api ? await api.queries.get(id) : null;
        if (cancelled) return;
        setRecord(rec);
        if (rec && api) {
          try {
            const recs = await api.recommendations.list(rec.connectionId);
            const match = recs.find((r) => r.sourceFingerprints.includes(rec.fingerprint));
            if (!cancelled) setRecommendation(match);
          } catch {
            /* recommendations optional */
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load query');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onRerun = async (): Promise<void> => {
    const api = getApi();
    if (!api || !record) return;
    const updated = await explain.run(() =>
      api.queries.explain(record.connectionId, record.rawQuery),
    );
    if (updated) setRecord(updated);
  };

  if (loading) return <Loading label="Loading query…" />;
  if (error != null) return <ErrorBanner message={error} />;
  if (!record) {
    return (
      <EmptyState
        title="Query not found"
        description="This query record may have been pruned."
        action={
          <Button variant="secondary" onClick={() => navigate('/monitoring')}>
            Back to monitoring
          </Button>
        }
      />
    );
  }

  const a = record.analysis;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            ← Back
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={queryTypeVariant(record.queryType)}>{record.queryType}</Badge>
              <span className="font-mono text-sm text-slate-200">{record.targetName}</span>
              <span className="text-xs text-slate-500">{record.databaseName}</span>
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {record.engine} · {record.source}
            </div>
          </div>
        </div>
        <Button variant="primary" onClick={() => void onRerun()} loading={explain.loading}>
          Re-run EXPLAIN
        </Button>
      </div>

      {explain.error != null && <ErrorBanner message={`EXPLAIN failed: ${explain.error}`} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Raw query" />
            <CardBody>
              <CodeBlock
                code={
                  record.engine === 'mysql' ? prettySql(record.rawQuery) : record.rawQuery
                }
                copyable
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Normalized (fingerprint)" subtitle={record.fingerprint} />
            <CardBody>
              <CodeBlock code={record.normalizedQuery} maxHeightClass="max-h-40" />
            </CardBody>
          </Card>

          {a ? (
            <Card>
              <CardHeader title="Execution plan" />
              <CardBody>
                <PlanTree node={a.executionPlan} />
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardBody>
                <EmptyState
                  title="No analysis yet"
                  description="Run EXPLAIN to analyze index usage for this query."
                />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Performance" />
            <CardBody className="space-y-4">
              {a ? (
                <>
                  <div className="flex items-center gap-4">
                    <ScoreRing score={a.performanceScore} size={72} strokeWidth={6} />
                    <div className="space-y-1 text-xs">
                      <IndexVerdict analysis={a} />
                      <div className="text-slate-400">
                        {a.indexesUsed.length > 0
                          ? `Indexes: ${a.indexesUsed.join(', ')}`
                          : 'No indexes used'}
                      </div>
                    </div>
                  </div>
                  <ScoreBars breakdown={a.scoreBreakdown} />
                </>
              ) : (
                <div className="text-xs text-slate-500">No score available.</div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Metrics" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <Metric label="Avg time" value={formatMs(record.avgExecutionTimeMs ?? record.executionTimeMs)} />
                <Metric label="Max time" value={formatMs(record.maxExecutionTimeMs)} />
                <Metric label="Executions" value={formatNumber(record.executionCount ?? 1)} />
                <Metric label="Rows examined" value={a ? formatNumber(a.rowsExamined) : '—'} />
                <Metric label="Rows returned" value={a ? formatNumber(a.rowsReturned) : '—'} />
                <Metric label="Selectivity" value={a ? formatPct(a.selectivity, 1) : '—'} />
              </dl>
            </CardBody>
          </Card>

          {recommendation && (
            <Card>
              <CardHeader
                title="Recommendation"
                actions={<Badge variant="warn">{recommendation.kind}</Badge>}
              />
              <CardBody className="space-y-2">
                <p className="text-xs text-slate-300">{recommendation.rationale}</p>
                {recommendation.estimatedImpact && (
                  <p className="text-xs text-good">{recommendation.estimatedImpact}</p>
                )}
                <CodeBlock code={recommendation.ddl} copyable maxHeightClass="max-h-40" />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-mono text-slate-100">{value}</dd>
    </>
  );
}

function IndexVerdict({ analysis }: { analysis: NonNullable<QueryRecord['analysis']> }): JSX.Element {
  if (analysis.fullTableScan || analysis.collectionScan) {
    return <Badge variant="bad">{analysis.collectionScan ? 'Collection scan' : 'Full table scan'}</Badge>;
  }
  if (analysis.usesIndex) return <Badge variant="good">Uses index</Badge>;
  return <Badge variant="warn">No index</Badge>;
}

function ScoreBars({ breakdown }: { breakdown: ScoreBreakdown }): JSX.Element {
  const factors: Array<{ label: string; value: number }> = [
    { label: 'Index usage', value: breakdown.indexUsage },
    { label: 'Selectivity', value: breakdown.selectivity },
    { label: 'Scan penalty', value: breakdown.scanPenalty },
    { label: 'Latency', value: breakdown.latency },
  ];
  return (
    <div className="space-y-2">
      {factors.map((f) => {
        const pct = Math.max(0, Math.min(1, f.value)) * 100;
        const color = pct >= 75 ? 'bg-good' : pct >= 45 ? 'bg-warn' : 'bg-bad';
        return (
          <div key={f.label} className="space-y-1">
            <div className="flex justify-between text-xs text-slate-400">
              <span>{f.label}</span>
              <span className="font-mono">{Math.round(pct)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-700">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlanTree({ node, depth = 0 }: { node: ExecutionPlanNode; depth?: number }): JSX.Element {
  const isScan = /ALL|COLLSCAN|FULL/i.test(node.stage);
  const isIndex = /IXSCAN|ref|range|eq_ref|index/i.test(node.stage);
  const stageVariant = isScan ? 'bad' : isIndex ? 'good' : 'neutral';
  return (
    <div style={{ marginLeft: depth > 0 ? 16 : 0 }} className={depth > 0 ? 'border-l border-base-700 pl-3' : ''}>
      <div className="flex flex-wrap items-center gap-2 py-1">
        <Badge variant={stageVariant}>{node.stage}</Badge>
        {node.target && <span className="font-mono text-xs text-slate-300">{node.target}</span>}
        {node.indexName && (
          <span className="font-mono text-xs text-accent">idx: {node.indexName}</span>
        )}
        {node.rowsExamined != null && (
          <span className="text-xs text-slate-500">examined {formatNumber(node.rowsExamined)}</span>
        )}
        {node.rowsReturned != null && (
          <span className="text-xs text-slate-500">returned {formatNumber(node.rowsReturned)}</span>
        )}
        {node.estimatedCost != null && (
          <span className="text-xs text-slate-500">cost {node.estimatedCost.toFixed(1)}</span>
        )}
      </div>
      {node.detail && <div className="pb-1 text-xs text-slate-500">{node.detail}</div>}
      {node.children?.map((child, i) => (
        <PlanTree key={`${child.stage}-${i}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
