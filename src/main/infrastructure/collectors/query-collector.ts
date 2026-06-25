/**
 * QueryCollector — polls one connection's observability source on an interval,
 * analyzes new queries, persists the digests, and emits them. See
 * MONITORING_FLOW.md for the end-to-end pipeline.
 *
 * On start it primes the checkpoint with one discarded poll so the first real
 * tick reports per-window deltas rather than the database's entire cumulative
 * history.
 */

import { randomUUID } from 'node:crypto';
import type {
  IQueryCollector,
  CollectorState,
  CollectorEvents,
} from '@main/domain/services/query-collector';
import type { IDatabaseConnector } from '@main/domain/services/database-connector';
import type { IQueryAnalyzer } from '@main/domain/services/query-analyzer';
import type {
  IQueryHistoryRepository,
  IWorkloadSampleRepository,
} from '@main/domain/repositories';
import type { MonitoringSettings } from '@shared/types/metrics';
import type { QueryRecord } from '@shared/types/query';
import type { WorkloadSample } from '@shared/types/workload';

/** Read query types that can exhibit repeated-lookup (N+1) bursts. */
const SAMPLED_QUERY_TYPES = new Set<QueryRecord['queryType']>([
  'select',
  'find',
  'count',
  'aggregate',
]);

/** How long workload samples are retained before pruning (24h). */
const SAMPLE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class QueryCollector implements IQueryCollector {
  private _state: CollectorState = 'idle';
  private timer: NodeJS.Timeout | null = null;
  private checkpoint: string | null = null;
  private polling = false;
  private pollsSincePrune = 0;
  private settings: MonitoringSettings | null = null;
  /** Start of the window the next tick will report; advanced every tick. */
  private windowStart = new Date().toISOString();
  private readonly handlers = new Map<keyof CollectorEvents, Set<(...a: never[]) => void>>();

  constructor(
    public readonly connectionId: string,
    private readonly connector: IDatabaseConnector,
    private readonly analyzer: IQueryAnalyzer,
    private readonly queryRepo: IQueryHistoryRepository,
    private readonly sampleRepo: IWorkloadSampleRepository,
    private readonly source: QueryRecord['source'],
  ) {
    this.connector.on('status', (s) => this.emit('status', s));
    this.connector.on('error', (e) => {
      this.setState('error');
      this.emit('error', e);
    });
  }

  get state(): CollectorState {
    return this._state;
  }

  async start(settings: MonitoringSettings): Promise<void> {
    if (this._state === 'running') return;
    this.settings = settings;
    // Prime checkpoint (discard the baseline cumulative counters).
    const primed = await this.connector.collectSince(null);
    this.checkpoint = primed.nextCheckpoint;
    this.windowStart = new Date().toISOString();
    this.setState('running');
    this.scheduleNext();
  }

  pause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this._state === 'running') this.setState('paused');
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this.setState('running');
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setState('idle');
  }

  on<E extends keyof CollectorEvents>(event: E, handler: CollectorEvents[E]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (...a: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (...a: never[]) => void);
  }

  private scheduleNext(): void {
    const interval = this.settings?.pollIntervalMs ?? 5000;
    this.timer = setTimeout(() => void this.tick(), interval);
  }

  private async tick(): Promise<void> {
    if (this.polling || this._state !== 'running') return;
    this.polling = true;
    const windowStart = this.windowStart;
    const windowEnd = new Date().toISOString();
    this.windowStart = windowEnd;
    try {
      const { queries, nextCheckpoint } = await this.connector.collectSince(this.checkpoint);
      this.checkpoint = nextCheckpoint;

      if (queries.length) {
        const records: QueryRecord[] = [];
        for (const raw of queries) {
          const opts = { slowThresholdMs: this.settings?.slowQueryThresholdMs ?? 100 };
          records.push(await this.analyzer.toRecord(raw, this.connector, this.source, opts));
        }
        await this.queryRepo.bulkUpsert(records);
        const samples = this.toSamples(records, windowStart, windowEnd);
        if (samples.length) await this.sampleRepo.bulkInsert(samples);
        this.emit('queries', records);
      }

      if (++this.pollsSincePrune >= 20 && this.settings) {
        this.pollsSincePrune = 0;
        await this.queryRepo.prune(this.connectionId, this.settings.historyRetentionLimit);
        const before = new Date(Date.parse(windowEnd) - SAMPLE_RETENTION_MS).toISOString();
        await this.sampleRepo.prune(this.connectionId, before);
      }
    } catch (err) {
      this.emit('error', err as Error);
    } finally {
      this.polling = false;
      if (this._state === 'running') this.scheduleNext();
    }
  }

  /**
   * Fold this tick's records into one workload sample per fingerprint. MySQL
   * already reports one digest-delta record per fingerprint; MongoDB reports one
   * record per profiled event, so same-fingerprint records are summed. Counts
   * stored as totals over the window (analysis carries per-execution averages).
   * Only read query types that can show repeated-lookup bursts are sampled.
   */
  private toSamples(
    records: QueryRecord[],
    windowStart: string,
    windowEnd: string,
  ): WorkloadSample[] {
    const byFingerprint = new Map<string, WorkloadSample>();
    for (const r of records) {
      if (!SAMPLED_QUERY_TYPES.has(r.queryType)) continue;
      const count = r.executionCount ?? 1;
      const totalTime = r.executionTimeMs * count;
      const examined = (r.analysis?.rowsExamined ?? 0) * count;
      const returned = (r.analysis?.rowsReturned ?? 0) * count;
      const usesIndex = r.analysis?.usesIndex ?? false;

      const existing = byFingerprint.get(r.fingerprint);
      if (existing) {
        existing.executionCount += count;
        existing.totalTimeMs += totalTime;
        existing.rowsExamined += examined;
        existing.rowsReturned += returned;
        // A single scan over the window means the lookup isn't reliably indexed.
        existing.usesIndex = existing.usesIndex && usesIndex;
      } else {
        byFingerprint.set(r.fingerprint, {
          id: randomUUID(),
          connectionId: this.connectionId,
          engine: r.engine,
          fingerprint: r.fingerprint,
          normalizedQuery: r.normalizedQuery,
          queryType: r.queryType,
          databaseName: r.databaseName,
          targetName: r.targetName,
          windowStart,
          windowEnd,
          executionCount: count,
          totalTimeMs: totalTime,
          rowsExamined: examined,
          rowsReturned: returned,
          usesIndex,
        });
      }
    }
    return [...byFingerprint.values()];
  }

  private setState(state: CollectorState): void {
    this._state = state;
    this.emit('state', state);
  }

  private emit<E extends keyof CollectorEvents>(event: E, ...args: Parameters<CollectorEvents[E]>): void {
    this.handlers.get(event)?.forEach((h) => (h as (...a: unknown[]) => void)(...args));
  }
}
