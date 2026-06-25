/**
 * Turns a connector-reported {@link CapabilityIssue} into a concrete, guided
 * fix: a one-line "why", and where it helps, a copy-ready command (a GRANT
 * statement or a config snippet) pre-filled with this connection's user / host
 * / database. This is the single place that knows how to *resolve* each
 * {@link CapabilityCode}, so the UI never has to parse free-text messages.
 */

import type { CapabilityCode, CapabilityIssue, ConnectionConfig } from '@shared/types/database';

/** The bits of a connection a fix template needs to fill in commands. */
export interface ConnectionContext {
  // `| undefined` is explicit because exactOptionalPropertyTypes is on and we
  // copy these straight off a config where they may be undefined.
  username?: string | undefined;
  host?: string | undefined;
  database?: string | undefined;
}

export interface CapabilityFix {
  /** Short imperative title, e.g. "Grant read access to performance_schema". */
  title: string;
  /** One sentence on why monitoring needs this. */
  why: string;
  /** Optional manual steps when there's no single command to copy. */
  steps?: string[];
  /** Copy-ready command (SQL / mongosh / config), pre-filled where possible. */
  command?: string;
  /** Where/how to run the command, and any caveat (e.g. restart required). */
  commandNote?: string;
}

/** Pull the fix-template context out of a saved or in-progress connection. */
export function contextFromConfig(config: ConnectionContext | ConnectionConfig): ConnectionContext {
  return {
    username: config.username,
    host: config.host,
    database: config.database,
  };
}

const sqlUser = (ctx: ConnectionContext): string => ctx.username?.trim() || 'your_user';
// The app connects over the network, so the grant almost always targets '%'
// rather than the literal host the user typed; we leave a clear placeholder.
const sqlHost = (): string => '%';
const mongoDb = (ctx: ConnectionContext): string => ctx.database?.trim() || 'your_db';

/** Resolve the guided fix for a single capability code. */
export function fixFor(code: CapabilityCode, ctx: ConnectionContext): CapabilityFix {
  switch (code) {
    case 'mysql.performance_schema_disabled':
      return {
        title: 'Enable performance_schema',
        why: 'Query Vitals reads query statistics from performance_schema, which is currently off on the server.',
        command: '[mysqld]\nperformance_schema = ON',
        commandNote:
          'Add this to my.cnf / my.ini and restart MySQL. performance_schema cannot be turned on at runtime.',
      };
    case 'mysql.no_perfschema_select':
      return {
        title: 'Grant read access to performance_schema',
        why: 'The monitoring account cannot read events_statements_summary_by_digest, the table the poller relies on.',
        command: `GRANT SELECT ON \`performance_schema\`.* TO '${sqlUser(ctx)}'@'${sqlHost()}';\nFLUSH PRIVILEGES;`,
        commandNote: `Run as a MySQL admin. Replace '${sqlHost()}' with your account's host if it isn't a wildcard.`,
      };
    case 'mongo.no_target_database':
      return {
        title: 'Set a target database',
        why: 'No database is configured for this connection, so there is nothing to profile.',
        steps: [
          'Edit this connection and fill in the Database field with the database you want to monitor.',
        ],
      };
    case 'mongo.no_profiling_access':
      return {
        title: 'Grant profiler access',
        why: 'The account cannot read or manage the database profiler, the source of MongoDB query observations.',
        command: `db.grantRolesToUser("${sqlUser(ctx)}", [{ role: "dbAdmin", db: "${mongoDb(ctx)}" }])`,
        commandNote:
          'Run in mongosh against the admin database as a user administrator. clusterMonitor also works for read-only monitoring.',
      };
    default: {
      // Exhaustiveness guard: a new CapabilityCode must get a fix here.
      const _never: never = code;
      throw new Error(`No fix mapping for capability code: ${String(_never)}`);
    }
  }
}

/** Convenience: resolve the fix for an issue, falling back to its message. */
export function fixForIssue(issue: CapabilityIssue, ctx: ConnectionContext): CapabilityFix {
  try {
    return fixFor(issue.code, ctx);
  } catch {
    // Unknown code (older/newer backend): surface the raw message rather than crash.
    return { title: 'Missing capability', why: issue.message };
  }
}
