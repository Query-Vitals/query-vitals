/**
 * MongoDB 5+ adapter.
 *
 * Collection: enables the database profiler (level 1 with a slowms threshold)
 * and tails the capped `system.profile` collection. Each profile entry is a
 * single observed execution — unlike MySQL's cumulative digest table — so the
 * checkpoint is simply the last-seen `ts` and we emit every newer entry. The
 * analyzer/history layer then collapses repeats by fingerprint.
 *
 * Plans come from `explain("executionStats")` (run via the `explain` command).
 * Existing-index metadata comes from `listIndexes`, enriched with `$indexStats`
 * access counts for the unused-index rule (consumed in Phase 4).
 */

import { MongoClient } from 'mongodb';
import type { Db, Document, MongoClientOptions } from 'mongodb';
import type {
  IDatabaseConnector,
  RawObservedQuery,
  ExistingIndex,
  ConnectorEvents,
} from '@main/domain/services/database-connector';
import type {
  MongoConnectionConfig,
  ConnectionStatus,
  ConnectionTestResult,
  CapabilityIssue,
} from '@shared/types/database';
import type { ExecutionPlanNode, IndexAnalysis } from '@shared/types/query';
import { parseMongoExplain } from './mongo-explain-parser';

/**
 * Profiler level 2 records *every* operation (parity with MySQL's
 * performance_schema, which sees all statements). Level 1 + a slowms threshold
 * would silently drop fast queries — exactly the un-indexed-but-quick queries
 * this tool exists to surface — so we capture all and restore the prior level
 * on disconnect.
 */
const PROFILE_LEVEL_ALL = 2;
/** Default slow threshold (ms) for scoring a manual explain (re-scored later). */
const DEFAULT_SLOW_MS = 100;
const CONNECT_TIMEOUT_MS = 8000;
/** Databases we never profile or report on. */
const SYSTEM_DBS = new Set(['admin', 'config', 'local']);
/** Command document keys that are session/cluster metadata, not query shape. */
const META_COMMAND_KEYS = new Set([
  'lsid',
  '$db',
  '$clusterTime',
  '$readPreference',
  'readConcern',
  'writeConcern',
  'apiVersion',
  'apiStrict',
  'apiDeprecationErrors',
  'comment',
  'maxTimeMS',
]);

/** Read-style profiler ops we care about (writes still carry a query shape). */
const OBSERVED_OPS = new Set(['query', 'command', 'update', 'remove']);
/** Top-level command verbs that describe a real query we can analyze. */
const QUERY_COMMANDS = new Set([
  'find',
  'aggregate',
  'count',
  'distinct',
  'findAndModify',
  'update',
  'delete',
]);

interface ProfileCheckpoint {
  lastTs: string | null;
}

export class MongoConnector implements IDatabaseConnector {
  private client: MongoClient | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private profilingEnabledByUs = false;
  /** Profiling level that was in effect before we raised it, to restore later. */
  private previousProfilingLevel: number | null = null;
  private readonly handlers = new Map<keyof ConnectorEvents, Set<(...a: never[]) => void>>();

  constructor(
    public readonly config: MongoConnectionConfig,
    private readonly password: string | null,
  ) {}

  get status(): ConnectionStatus {
    return this._status;
  }

  /** Database we profile / inspect. Falls back to the auth source, then "test". */
  private get dbName(): string {
    return this.config.database || this.config.authSource || 'test';
  }

  private uri(): string {
    return `mongodb://${this.config.host}:${this.config.port}`;
  }

  private clientOptions(): MongoClientOptions {
    return {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
      ...(this.config.username && this.password
        ? { auth: { username: this.config.username, password: this.password } }
        : {}),
      ...(this.config.authSource ? { authSource: this.config.authSource } : {}),
      ...(this.config.replicaSet ? { replicaSet: this.config.replicaSet } : {}),
      ...(this.config.tls?.enabled
        ? {
            tls: true,
            tlsAllowInvalidCertificates: this.config.tls.rejectUnauthorized === false,
          }
        : {}),
    };
  }

  async test(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const client = new MongoClient(this.uri(), this.clientOptions());
    try {
      await client.connect();
      const db = client.db(this.dbName);
      const info = (await db.command({ buildInfo: 1 })) as Document;
      const serverVersion = String(info['version'] ?? '');

      const issues: CapabilityIssue[] = [];
      if (!this.config.database) {
        issues.push({
          code: 'mongo.no_target_database',
          message: `No target database configured (defaulting to "${this.dbName}")`,
        });
      }
      try {
        // Reading the profiling status proves we can manage the profiler.
        await db.command({ profile: -1 });
      } catch {
        issues.push({
          code: 'mongo.no_profiling_access',
          message: `The account cannot manage profiling on "${this.dbName}"`,
        });
      }

      return {
        ok: true,
        latencyMs: Date.now() - started,
        serverVersion,
        monitoringCapable: issues.length === 0,
        ...(issues.length ? { capabilityIssues: issues } : {}),
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      await client.close();
    }
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.setStatus('connecting');
    try {
      const client = new MongoClient(this.uri(), this.clientOptions());
      await client.connect();
      await client.db(this.dbName).command({ ping: 1 });
      this.client = client;
      await this.enableProfiling();
      this.setStatus('connected');
    } catch (err) {
      this.client = null;
      this.setStatus('error');
      this.emit('error', err as Error);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      // Best-effort: restore the prior profiling level if we raised it.
      if (this.profilingEnabledByUs) {
        try {
          await this.client.db(this.dbName).command({ profile: this.previousProfilingLevel ?? 0 });
        } catch {
          /* not fatal — closing anyway */
        }
        this.profilingEnabledByUs = false;
        this.previousProfilingLevel = null;
      }
      await this.client.close();
      this.client = null;
    }
    this.setStatus('disconnected');
  }

  async explain(
    rawQuery: string,
    databaseName: string,
  ): Promise<{ plan: ExecutionPlanNode; rawPlan: unknown; analysis: IndexAnalysis }> {
    const db = this.requireDb(databaseName);
    const command = stripMeta(parseCommand(rawQuery));
    const result = (await db.command({
      explain: command,
      verbosity: 'executionStats',
    })) as Document;
    return parseMongoExplain(result, 0, DEFAULT_SLOW_MS);
  }

  async listIndexes(databaseName: string, targetName?: string): Promise<ExistingIndex[]> {
    const db = this.requireDb(databaseName);
    const dbn = databaseName || this.dbName;

    const collections = targetName
      ? [targetName]
      : (await db.listCollections({}, { nameOnly: true }).toArray())
          .map((c) => String((c as Document)['name']))
          .filter((n) => !n.startsWith('system.'));

    const out: ExistingIndex[] = [];
    for (const coll of collections) {
      const collection = db.collection(coll);

      // $indexStats access counts (best-effort: needs privileges).
      const accessByName = new Map<string, number>();
      try {
        const stats = await collection.aggregate([{ $indexStats: {} }]).toArray();
        for (const s of stats) {
          const doc = s as Document;
          const name = String(doc['name'] ?? '');
          const ops = Number((doc['accesses'] as Document | undefined)?.['ops'] ?? 0);
          if (name) accessByName.set(name, ops);
        }
      } catch {
        /* $indexStats unavailable — leave accessCount undefined */
      }

      let indexes: Document[];
      try {
        indexes = (await collection.listIndexes().toArray()) as Document[];
      } catch {
        continue; // collection may have been dropped mid-scan
      }

      for (const idx of indexes) {
        const name = String(idx['name'] ?? '');
        const key = (idx['key'] ?? {}) as Record<string, unknown>;
        const fields = Object.entries(key).map(([field, dir]) => ({
          name: field,
          // Non-numeric key types (text, 2dsphere, hashed) are treated as asc.
          direction: (Number(dir) === -1 ? -1 : 1) as 1 | -1,
        }));
        const existing: ExistingIndex = {
          name,
          databaseName: dbn,
          targetName: coll,
          fields,
          unique: idx['unique'] === true,
        };
        const access = accessByName.get(name);
        if (access != null) existing.accessCount = access;
        out.push(existing);
      }
    }
    return out;
  }

  async collectSince(
    checkpoint: string | null,
  ): Promise<{ queries: RawObservedQuery[]; nextCheckpoint: string }> {
    const db = this.requireDb('');
    const cp: ProfileCheckpoint = checkpoint
      ? (JSON.parse(checkpoint) as ProfileCheckpoint)
      : { lastTs: null };

    const filter: Document = cp.lastTs ? { ts: { $gt: new Date(cp.lastTs) } } : {};
    const docs = (await db
      .collection('system.profile')
      .find(filter)
      .sort({ ts: 1 })
      .limit(1000)
      .toArray()) as Document[];

    const queries: RawObservedQuery[] = [];
    let maxTs = cp.lastTs;

    for (const doc of docs) {
      const ts = toIso(doc['ts']);
      if (!maxTs || ts > maxTs) maxTs = ts;

      const op = String(doc['op'] ?? '');
      if (!OBSERVED_OPS.has(op)) continue;

      const ns = String(doc['ns'] ?? '');
      const [nsDb, ...rest] = ns.split('.');
      const collection = rest.join('.');
      if (!nsDb || SYSTEM_DBS.has(nsDb) || collection.startsWith('system.')) continue;

      const command = stripMeta((doc['command'] as Document | undefined) ?? {});
      const verb = Object.keys(command)[0] ?? '';
      // Skip our own explains and anything that isn't a recognizable query.
      if ('explain' in command || !QUERY_COMMANDS.has(verb)) continue;

      const docsExamined = Number(doc['docsExamined'] ?? 0);
      const keysExamined = Number(doc['keysExamined'] ?? 0);
      const nreturned = Number(doc['nreturned'] ?? doc['nReturned'] ?? 0);
      const planSummary = String(doc['planSummary'] ?? '');
      const collectionScan = planSummary.includes('COLLSCAN');
      const usedIndex = planSummary.includes('IXSCAN') || keysExamined > 0;

      queries.push({
        rawQuery: JSON.stringify(command),
        databaseName: nsDb,
        targetName: collection || String(command[verb] ?? ''),
        timestamp: ts,
        executionTimeMs: Number(doc['millis'] ?? 0),
        metrics: {
          executionCount: 1,
          rowsExamined: Math.max(docsExamined, keysExamined),
          rowsReturned: nreturned,
          noIndexUsed: collectionScan || !usedIndex,
          // For Mongo, the "scan" flag carries a collection scan.
          fullTableScan: collectionScan,
          maxExecutionTimeMs: Number(doc['millis'] ?? 0),
        },
      });
    }

    cp.lastTs = maxTs;
    return { queries, nextCheckpoint: JSON.stringify(cp) };
  }

  on<E extends keyof ConnectorEvents>(event: E, handler: ConnectorEvents[E]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (...a: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (...a: never[]) => void);
  }

  private async enableProfiling(): Promise<void> {
    if (!this.client) return;
    try {
      const db = this.client.db(this.dbName);
      const status = (await db.command({ profile: -1 })) as Document;
      const was = Number(status['was'] ?? 0);
      // Raise to "capture all" unless it's already there. Remember the prior
      // level so disconnect can restore it.
      if (was < PROFILE_LEVEL_ALL) {
        this.previousProfilingLevel = was;
        await db.command({ profile: PROFILE_LEVEL_ALL });
        this.profilingEnabledByUs = true;
      }
    } catch (err) {
      // Non-fatal: we stay connected, but without profiling no queries appear.
      // Surfacing the error lets the UI explain why monitoring sees nothing
      // (usually a missing dbAdmin/clusterMonitor privilege on the database).
      this.emit('error', err as Error);
    }
  }

  private emit<E extends keyof ConnectorEvents>(
    event: E,
    ...args: Parameters<ConnectorEvents[E]>
  ): void {
    this.handlers.get(event)?.forEach((h) => (h as (...a: unknown[]) => void)(...args));
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.emit('status', status);
  }

  private requireDb(databaseName: string): Db {
    if (!this.client) throw new Error('MongoConnector is not connected');
    return this.client.db(databaseName || this.dbName);
  }
}

/** Parse a profiler/manual command document from its JSON string form. */
function parseCommand(rawQuery: string): Document {
  try {
    const parsed: unknown = JSON.parse(rawQuery);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Document;
  } catch {
    /* fall through */
  }
  throw new Error('MongoConnector.explain expects a JSON command document');
}

/** Drop session/cluster metadata so only the query shape remains. */
function stripMeta(command: Document): Document {
  const out: Document = {};
  for (const [k, v] of Object.entries(command)) {
    if (!META_COMMAND_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
