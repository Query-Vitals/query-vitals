import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { QueryRecord } from '@shared/types/query';
import type { ConnectionTestResult } from '@shared/types/database';
import { PreflightChecklist } from '@renderer/features/connections/PreflightChecklist';
import { contextFromConfig } from '@renderer/features/connections/capability-guidance';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Input,
  Loading,
  ScoreRing,
  Select,
  Table,
  type Column,
  type SortState,
} from '@renderer/shared/ui';
import { getApi, useMutation } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';
import {
  formatMs,
  formatNumber,
  formatPct,
  queryTypeVariant,
  truncate,
} from '@renderer/shared/lib/format';

/** Merge incoming records into the list, dedupe by fingerprint, keep latest. */
function mergeRecords(existing: QueryRecord[], incoming: QueryRecord[]): QueryRecord[] {
  const byFp = new Map<string, QueryRecord>();
  for (const r of existing) byFp.set(r.fingerprint, r);
  for (const r of incoming) byFp.set(r.fingerprint, r);
  return [...byFp.values()].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

type IndexStatus = 'all' | 'indexed' | 'noindex' | 'scan';

/** Classify a record's index verdict for the status filter. */
function indexStatusOf(r: QueryRecord): Exclude<IndexStatus, 'all'> | 'unknown' {
  const a = r.analysis;
  if (!a) return 'unknown';
  if (a.fullTableScan || a.collectionScan) return 'scan';
  return a.usesIndex ? 'indexed' : 'noindex';
}

/** Comparable numeric value for a sortable column key (missing sorts last). */
function sortValue(r: QueryRecord, key: string): number {
  switch (key) {
    case 'avg':
      return r.avgExecutionTimeMs ?? r.executionTimeMs ?? -Infinity;
    case 'count':
      return r.executionCount ?? 1;
    case 'selectivity':
      return r.analysis?.selectivity ?? -Infinity;
    case 'score':
      return r.analysis?.performanceScore ?? -Infinity;
    case 'time':
      return new Date(r.timestamp).getTime();
    default:
      return 0;
  }
}

export default function MonitoringScreen(): JSX.Element {
  const navigate = useNavigate();
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  // Running state is sourced from the store (synced from the backend + push
  // events), so it survives tab navigation that unmounts this screen.
  const monitoring = useAppStore((s) =>
    activeConnectionId ? (s.monitoringStatus[activeConnectionId] ?? false) : false,
  );
  const setMonitoring = useAppStore((s) => s.setMonitoring);
  const connections = useAppStore((s) => s.connections);
  const activeConn = useMemo(
    () => connections.find((c) => c.id === activeConnectionId),
    [connections, activeConnectionId],
  );

  const [records, setRecords] = useState<QueryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Preflight: can this connection actually be monitored? Drives the guidance
  // panel and gates the Start button so the user isn't left staring at an
  // empty table wondering whether it's broken or just idle.
  const [preflight, setPreflight] = useState<ConnectionTestResult | undefined>(undefined);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const start = useMutation();
  const stop = useMutation();

  // Client-side view controls (purely presentational; data stays untouched).
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [indexFilter, setIndexFilter] = useState<IndexStatus>('all');
  const [sort, setSort] = useState<SortState | undefined>(undefined);

  // Toggle sort: asc -> desc -> off when clicking the same column header.
  const onSortChange = useCallback((key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, direction: 'desc' };
      if (prev.direction === 'desc') return { key, direction: 'asc' };
      return undefined;
    });
  }, []);

  const recordsRef = useRef(records);
  recordsRef.current = records;

  // Load initial rows whenever the active connection changes.
  const load = useCallback(async (connectionId: string) => {
    const api = getApi();
    if (!api) return;
    setLoading(true);
    setError(undefined);
    try {
      const rows = await api.queries.list({ connectionId, limit: 200 });
      setRecords(mergeRecords([], rows));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queries');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRecords([]);
    if (activeConnectionId) void load(activeConnectionId);
  }, [activeConnectionId, load]);

  // Re-check monitoring capabilities for the active connection (uses the stored
  // secret on the backend). Exposed so the user can re-run it after fixing a
  // privilege or enabling logging, without reopening the connection form.
  const loadPreflight = useCallback(async (connectionId: string) => {
    const api = getApi();
    if (!api) return;
    setPreflightLoading(true);
    try {
      setPreflight(await api.connections.capabilities(connectionId));
    } catch {
      // Leave preflight undefined: don't block Start on a failed self-check.
      setPreflight(undefined);
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    setPreflight(undefined);
    if (activeConnectionId) void loadPreflight(activeConnectionId);
  }, [activeConnectionId, loadPreflight]);

  // Reconcile the running flag with the backend's actual collector state on
  // mount / connection change (covers screen remount and renderer reload).
  useEffect(() => {
    const api = getApi();
    if (!api || !activeConnectionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const running = await api.monitoring.status(activeConnectionId);
        if (!cancelled) setMonitoring(activeConnectionId, running);
      } catch {
        /* leave the last known state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConnectionId, setMonitoring]);

  // Subscribe to live capture events for the active connection.
  useEffect(() => {
    const api = getApi();
    if (!api?.on || !activeConnectionId) return;
    const unsubscribe = api.on('events:queriesCaptured', (incoming) => {
      const relevant = incoming.filter((r) => r.connectionId === activeConnectionId);
      if (relevant.length === 0) return;
      setRecords((prev) => mergeRecords(prev, relevant));
    });
    return unsubscribe;
  }, [activeConnectionId]);

  // Block Start when the preflight self-check ran and found the connection
  // either unreachable or unable to monitor — starting would only produce an
  // empty table. An undefined/in-flight preflight never blocks.
  const blockedByPreflight =
    preflight != null && (preflight.ok === false || preflight.monitoringCapable === false);

  const onStart = async (): Promise<void> => {
    const api = getApi();
    if (!api || !activeConnectionId || blockedByPreflight) return;
    // monitoring.start resolves to void, so return a sentinel to tell a
    // successful call apart from a failure (run() returns undefined on throw).
    const ok = await start.run(async () => {
      await api.monitoring.start(activeConnectionId);
      return true;
    });
    if (ok) setMonitoring(activeConnectionId, true);
  };
  const onStop = async (): Promise<void> => {
    const api = getApi();
    if (!api || !activeConnectionId) return;
    const ok = await stop.run(async () => {
      await api.monitoring.stop(activeConnectionId);
      return true;
    });
    if (ok) setMonitoring(activeConnectionId, false);
  };

  // Distinct query types present, for the type filter dropdown.
  const typeOptions = useMemo(() => {
    const types = [...new Set(records.map((r) => r.queryType))].sort();
    return [
      { value: 'all', label: 'All types' },
      ...types.map((t) => ({ value: t, label: t })),
    ];
  }, [records]);

  // Apply search + filters, then sort. The merge order (timestamp desc) is the
  // default when no explicit sort is active.
  const visibleRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = records.filter((r) => {
      if (typeFilter !== 'all' && r.queryType !== typeFilter) return false;
      if (indexFilter !== 'all' && indexStatusOf(r) !== indexFilter) return false;
      if (q) {
        const haystack = `${r.normalizedQuery} ${r.targetName} ${r.databaseName}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    if (sort) {
      const dir = sort.direction === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => (sortValue(a, sort.key) - sortValue(b, sort.key)) * dir);
    }
    return rows;
  }, [records, search, typeFilter, indexFilter, sort]);

  if (!activeConnectionId) {
    return (
      <EmptyState
        title="No active connection"
        description="Select or create a connection to start monitoring captured queries."
      />
    );
  }

  const columns: Array<Column<QueryRecord>> = [
    {
      key: 'type',
      header: 'Type',
      render: (r) => <Badge variant={queryTypeVariant(r.queryType)}>{r.queryType}</Badge>,
    },
    {
      key: 'query',
      header: 'Query',
      className: 'w-[40%]',
      render: (r) => (
        <span
          className="block max-w-[28rem] truncate font-mono text-xs text-slate-300"
          title={r.normalizedQuery}
        >
          {truncate(r.normalizedQuery, 160)}
        </span>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (r) => (
        <span className="block whitespace-nowrap font-mono text-xs text-slate-400">{r.targetName}</span>
      ),
    },
    {
      key: 'avg',
      header: 'Avg time',
      align: 'right',
      sortable: true,
      render: (r) => formatMs(r.avgExecutionTimeMs ?? r.executionTimeMs),
    },
    {
      key: 'count',
      header: 'Execs',
      align: 'right',
      sortable: true,
      render: (r) => formatNumber(r.executionCount ?? 1),
    },
    {
      key: 'index',
      header: 'Index',
      render: (r) => <IndexCell record={r} />,
    },
    {
      key: 'selectivity',
      header: 'Selectivity',
      align: 'right',
      sortable: true,
      render: (r) =>
        r.analysis ? formatPct(r.analysis.selectivity, 1) : <span className="text-slate-600">—</span>,
    },
    {
      key: 'score',
      header: 'Score',
      align: 'center',
      sortable: true,
      render: (r) =>
        r.analysis ? (
          <div className="flex justify-center">
            <ScoreRing score={r.analysis.performanceScore} size={34} />
          </div>
        ) : (
          <span className="text-slate-600">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Monitoring</h1>
          <p className="text-xs text-slate-400">
            {visibleRecords.length === records.length
              ? `${records.length} captured ${records.length === 1 ? 'query' : 'queries'}`
              : `${visibleRecords.length} of ${records.length} queries`}
            {monitoring ? ' · live' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void onStart()}
            loading={start.loading}
            disabled={monitoring || blockedByPreflight}
            title={blockedByPreflight ? 'Resolve the setup steps below before starting' : undefined}
          >
            Start
          </Button>
          <Button variant="secondary" onClick={() => void onStop()} loading={stop.loading} disabled={!monitoring}>
            Stop
          </Button>
        </div>
      </div>

      {(start.error ?? stop.error ?? error) != null && (
        <ErrorBanner message={start.error ?? stop.error ?? error ?? ''} />
      )}

      {/* Preflight guidance: show while a problem exists or nothing has been
          captured yet, so the user always knows whether they're blocked, idle,
          or good to go. Hidden once queries are flowing and all checks pass. */}
      {activeConn && preflight && (blockedByPreflight || records.length === 0) && (
        <div className="rounded-md border border-base-700 bg-base-800/40 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Preflight
            </h2>
            <Button
              variant="ghost"
              size="sm"
              loading={preflightLoading}
              onClick={() => void loadPreflight(activeConn.id)}
            >
              Re-check
            </Button>
          </div>
          <PreflightChecklist result={preflight} context={contextFromConfig(activeConn)} />
        </div>
      )}

      {records.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <Input
              label="Search"
              placeholder="Filter by query text, table, or database…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="w-40">
            <Select
              label="Type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              options={typeOptions}
            />
          </div>
          <div className="w-44">
            <Select
              label="Index status"
              value={indexFilter}
              onChange={(e) => setIndexFilter(e.target.value as IndexStatus)}
              options={[
                { value: 'all', label: 'All' },
                { value: 'indexed', label: 'Indexed' },
                { value: 'noindex', label: 'No index' },
                { value: 'scan', label: 'Full / coll scan' },
              ]}
            />
          </div>
        </div>
      )}

      {loading ? (
        <Loading label="Loading captured queries…" />
      ) : (
        <Table
          columns={columns}
          rows={visibleRecords}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/query/${r.id}`)}
          sort={sort}
          onSortChange={onSortChange}
          empty={
            records.length === 0
              ? 'No queries captured yet. Start monitoring and run some queries against your database.'
              : 'No queries match the current filters.'
          }
        />
      )}
    </div>
  );
}

function IndexCell({ record }: { record: QueryRecord }): JSX.Element {
  const a = record.analysis;
  if (!a) return <span className="text-slate-600">—</span>;
  if (a.fullTableScan || a.collectionScan) {
    return <Badge variant="bad">{a.collectionScan ? 'COLLSCAN' : 'Full scan'}</Badge>;
  }
  if (a.usesIndex) return <Badge variant="good">Indexed</Badge>;
  return <Badge variant="warn">No index</Badge>;
}
