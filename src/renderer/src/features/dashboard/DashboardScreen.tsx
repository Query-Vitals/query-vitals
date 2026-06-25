import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  DashboardMetrics,
  DashboardRanking,
  QueryTimePoint,
  TopQueryEntry,
} from '@shared/types/metrics';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorBanner,
  Loading,
  ScoreRing,
  Select,
  Table,
  type Column,
} from '@renderer/shared/ui';
import { getApi, useApi } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';
import {
  formatCompact,
  formatMs,
  formatNumber,
  formatPct,
  formatPctValue,
  formatTimeShort,
  truncate,
} from '@renderer/shared/lib/format';

const RANKING_OPTIONS = [
  { value: 'slowest', label: 'Slowest queries' },
  { value: 'most-executed', label: 'Most executed' },
  { value: 'full-scans', label: 'Full scans' },
  { value: 'poor-selectivity', label: 'Poor selectivity' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 60 * 60 * 1000; // 1h buckets over 24h

export default function DashboardScreen(): JSX.Element {
  const navigate = useNavigate();
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const [ranking, setRanking] = useState<DashboardRanking>('slowest');

  // Stable 24h window computed once per mount.
  const { from, to } = useMemo(() => {
    const now = Date.now();
    return { from: new Date(now - DAY_MS).toISOString(), to: new Date(now).toISOString() };
  }, []);

  const cid = activeConnectionId ?? '';

  const metrics = useApi<DashboardMetrics | undefined>(
    async () => {
      const api = getApi();
      if (!api || !cid) return undefined;
      return api.dashboard.metrics(cid, from, to);
    },
    [cid, from, to],
    { enabled: !!cid },
  );

  const series = useApi<QueryTimePoint[]>(
    async () => {
      const api = getApi();
      if (!api || !cid) return [];
      return api.dashboard.timeSeries(cid, from, to, BUCKET_MS);
    },
    [cid, from, to],
    { enabled: !!cid },
  );

  const top = useApi<TopQueryEntry[]>(
    async () => {
      const api = getApi();
      if (!api || !cid) return [];
      return api.dashboard.ranking(cid, ranking, 10);
    },
    [cid, ranking],
    { enabled: !!cid },
  );

  if (!activeConnectionId) {
    return (
      <EmptyState
        title="No active connection"
        description="Select a connection from the top bar to view its dashboard."
      />
    );
  }

  const m = metrics.data;
  const coverage = m?.indexCoveragePct ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Dashboard</h1>
        <p className="text-xs text-slate-400">Last 24 hours</p>
      </div>

      {metrics.error != null && <ErrorBanner message={`Failed to load metrics: ${metrics.error}`} />}

      {metrics.loading ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Total queries" value={formatNumber(m?.totalQueries ?? 0)} />
          <MetricCard label="Indexed" value={formatNumber(m?.indexedQueries ?? 0)} variant="good" />
          <MetricCard label="Non-indexed" value={formatNumber(m?.nonIndexedQueries ?? 0)} variant="warn" />
          <MetricCard label="Slow" value={formatNumber(m?.slowQueries ?? 0)} variant="bad" />
          <MetricCard label="Avg time" value={formatMs(m?.averageQueryTimeMs ?? 0)} />
          <CoverageCard pct={coverage} />
        </div>
      )}

      <Card>
        <CardHeader title="Query volume & latency" subtitle="avg ms (area) and count (line)" />
        <CardBody>
          {series.error != null && <ErrorBanner message={series.error} />}
          {series.loading ? (
            <Loading />
          ) : (series.data ?? []).length === 0 ? (
            <EmptyState
              title="No time-series data yet"
              description="Query volume and latency will chart here once monitoring has captured activity."
            />
          ) : (
            <TimeSeriesChart points={series.data ?? []} />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Top queries"
          actions={
            <div className="w-48">
              <Select
                value={ranking}
                onChange={(e) => setRanking(e.target.value as DashboardRanking)}
                options={RANKING_OPTIONS}
              />
            </div>
          }
        />
        <CardBody>
          {top.error != null && <ErrorBanner message={top.error} />}
          {top.loading ? (
            <Loading />
          ) : (
            <RankingTable
              rows={top.data ?? []}
              onRowClick={(r) => navigate(`/monitoring`)}
              fingerprintNote
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function MetricCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: 'good' | 'warn' | 'bad';
}): JSX.Element {
  const color =
    variant === 'good'
      ? 'text-good'
      : variant === 'warn'
        ? 'text-warn'
        : variant === 'bad'
          ? 'text-bad'
          : 'text-slate-100';
  return (
    <Card>
      <CardBody>
        <div className="text-xs text-slate-400">{label}</div>
        <div className={`mt-1 font-mono text-xl font-semibold ${color}`}>{value}</div>
      </CardBody>
    </Card>
  );
}

function CoverageCard({ pct }: { pct: number }): JSX.Element {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-400">Index coverage</div>
            <div className="mt-1 font-mono text-xl font-semibold text-slate-100">
              {formatPctValue(pct, 0)}
            </div>
          </div>
          <ScoreRing score={pct} size={44} hideLabel />
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Recharts renders to SVG and needs literal color strings (it can't consume
 * Tailwind classes), so the chart palette is mirrored here from the theme
 * tokens in tailwind.config.js. Keep these in sync with that file.
 */
const CHART = {
  avg: '#5b8def', // accent
  count: '#3fb950', // good
  grid: '#252c40', // ~base-700
  axisText: '#94a3b8', // slate-400
  tooltipBg: '#11151f', // ~base-900
} as const;

function TimeSeriesChart({ points }: { points: QueryTimePoint[] }): JSX.Element {
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="avgFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.avg} stopOpacity={0.4} />
              <stop offset="100%" stopColor={CHART.avg} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="timestamp"
            tickFormatter={formatTimeShort}
            tick={{ fill: CHART.axisText, fontSize: 11 }}
            stroke={CHART.grid}
          />
          <YAxis
            yAxisId="avg"
            tick={{ fill: CHART.axisText, fontSize: 11 }}
            stroke={CHART.grid}
            width={48}
          />
          <YAxis yAxisId="count" orientation="right" hide />
          <Tooltip
            contentStyle={{
              background: CHART.tooltipBg,
              border: `1px solid ${CHART.grid}`,
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(v) => formatTimeShort(String(v))}
            formatter={(value: number, name: string) =>
              name === 'avgMs' ? [formatMs(value), 'Avg'] : [formatNumber(value), 'Count']
            }
          />
          <Area
            yAxisId="avg"
            type="monotone"
            dataKey="avgMs"
            stroke={CHART.avg}
            strokeWidth={2}
            fill="url(#avgFill)"
          />
          <Line
            yAxisId="count"
            type="monotone"
            dataKey="count"
            stroke={CHART.count}
            strokeWidth={2}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RankingTable({
  rows,
  onRowClick,
}: {
  rows: TopQueryEntry[];
  onRowClick?: (r: TopQueryEntry) => void;
  fingerprintNote?: boolean;
}): JSX.Element {
  const columns: Array<Column<TopQueryEntry>> = [
    {
      key: 'query',
      header: 'Query',
      className: 'max-w-md',
      render: (r) => (
        <span className="font-mono text-xs text-slate-300" title={r.normalizedQuery}>
          {truncate(r.normalizedQuery, 70)}
        </span>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (r) => <span className="font-mono text-xs text-slate-400">{r.targetName}</span>,
    },
    { key: 'avg', header: 'Avg', align: 'right', render: (r) => formatMs(r.avgExecutionTimeMs) },
    { key: 'max', header: 'Max', align: 'right', render: (r) => formatMs(r.maxExecutionTimeMs) },
    { key: 'execs', header: 'Execs', align: 'right', render: (r) => formatCompact(r.executionCount) },
    {
      key: 'scan',
      header: 'Scan',
      render: (r) => (r.fullScan ? <Badge variant="bad">Full</Badge> : <Badge variant="good">No</Badge>),
    },
    { key: 'sel', header: 'Selectivity', align: 'right', render: (r) => formatPct(r.selectivity, 1) },
    {
      key: 'score',
      header: 'Score',
      align: 'center',
      render: (r) => (
        <div className="flex justify-center">
          <ScoreRing score={r.performanceScore} size={32} />
        </div>
      ),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(r) => r.fingerprint}
      {...(onRowClick ? { onRowClick } : {})}
      empty="No ranked queries for this window."
    />
  );
}
