/** DDL for the local SQLite store. Applied idempotently on startup. */

import type { SqliteDatabase } from './database';

export const SCHEMA_VERSION = 3;

export function applySchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      engine      TEXT NOT NULL,
      host        TEXT NOT NULL,
      port        INTEGER NOT NULL,
      username    TEXT,
      password_ref TEXT,
      database    TEXT,
      auth_source TEXT,
      replica_set TEXT,
      tls         TEXT,
      notes       TEXT,
      tags        TEXT,
      color       TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS query_history (
      id              TEXT PRIMARY KEY,
      connection_id   TEXT NOT NULL,
      engine          TEXT NOT NULL,
      source          TEXT NOT NULL,
      raw_query       TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      fingerprint     TEXT NOT NULL,
      query_type      TEXT NOT NULL,
      database_name   TEXT NOT NULL,
      target_name     TEXT NOT NULL,
      related_targets TEXT,
      execution_time_ms   REAL NOT NULL,
      timestamp       TEXT NOT NULL,
      execution_count INTEGER NOT NULL DEFAULT 1,
      avg_execution_time_ms REAL NOT NULL,
      max_execution_time_ms REAL NOT NULL,
      analysis        TEXT,
      UNIQUE (connection_id, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS idx_qh_conn_ts ON query_history (connection_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_qh_conn_avg ON query_history (connection_id, avg_execution_time_ms);

    CREATE TABLE IF NOT EXISTS recommendations (
      id            TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      engine        TEXT NOT NULL,
      kind          TEXT NOT NULL,
      severity      TEXT NOT NULL,
      database_name TEXT NOT NULL,
      target_name   TEXT NOT NULL,
      fields        TEXT NOT NULL,
      ddl           TEXT NOT NULL,
      rationale     TEXT NOT NULL,
      estimated_impact TEXT,
      source_fingerprints TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      dismissed     INTEGER NOT NULL DEFAULT 0,
      UNIQUE (connection_id, ddl)
    );

    CREATE TABLE IF NOT EXISTS settings (
      connection_id TEXT PRIMARY KEY,
      slow_query_threshold_ms INTEGER NOT NULL,
      poll_interval_ms        INTEGER NOT NULL,
      history_retention_limit INTEGER NOT NULL,
      auto_explain            INTEGER NOT NULL
    );

    -- Per-poll-window observations (Phase 6). Unlike query_history, which keeps
    -- one all-time digest per fingerprint, this table retains the temporal grain
    -- the workload analyzer needs to detect short repeated-lookup (N+1) bursts.
    CREATE TABLE IF NOT EXISTS workload_samples (
      id              TEXT PRIMARY KEY,
      connection_id   TEXT NOT NULL,
      engine          TEXT NOT NULL,
      fingerprint     TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      query_type      TEXT NOT NULL,
      database_name   TEXT NOT NULL,
      target_name     TEXT NOT NULL,
      window_start    TEXT NOT NULL,
      window_end      TEXT NOT NULL,
      execution_count INTEGER NOT NULL,
      total_time_ms   REAL NOT NULL,
      rows_examined   REAL NOT NULL,
      rows_returned   REAL NOT NULL,
      uses_index      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ws_conn_end ON workload_samples (connection_id, window_end);
    CREATE INDEX IF NOT EXISTS idx_ws_conn_fp ON workload_samples (connection_id, fingerprint);
  `);
  // Migrate databases created by older versions: `CREATE TABLE IF NOT EXISTS`
  // leaves an existing table untouched, so newly added columns must be applied
  // with ALTER TABLE. This is idempotent — it only adds columns that are
  // missing.
  addColumnIfMissing(db, 'connections', 'tags', 'TEXT');
  addColumnIfMissing(db, 'connections', 'color', 'TEXT');

  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    'schema_version',
    String(SCHEMA_VERSION),
  ]);
}

/** Add a column to a table only if it does not already exist. */
function addColumnIfMissing(
  db: SqliteDatabase,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.all(`PRAGMA table_info(${table})`);
  const exists = cols.some((c) => String(c['name']) === column);
  if (!exists) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export const DEFAULT_MONITORING_SETTINGS = {
  slowQueryThresholdMs: 100,
  pollIntervalMs: 5000,
  historyRetentionLimit: 5000,
  autoExplain: true,
} as const;
