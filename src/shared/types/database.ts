/**
 * Cross-process database domain types.
 * Shared between the Electron main process (backend) and renderer (UI).
 * Keep this file free of Node/Electron imports so it is safe to use in both.
 */

export type DatabaseEngine = 'mysql' | 'mongodb';

/** SSL / TLS configuration shared by both engines. */
export interface TlsConfig {
  enabled: boolean;
  /** Reject servers whose cert chain cannot be verified. */
  rejectUnauthorized?: boolean;
  caCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
}

interface BaseConnectionConfig {
  /** Stable UUID, generated on save. */
  id: string;
  /** Human-friendly label shown in the UI. */
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  /** Secrets are never persisted in plaintext; see SecretStore. */
  username?: string;
  /** Reference to a secret in the OS keychain, not the password itself. */
  passwordRef?: string;
  tls?: TlsConfig;
  /** Free-form notes the user can attach. */
  notes?: string;
  /**
   * Free-form labels to identify the connection, e.g. "production",
   * "staging", "read-replica". Used for quick visual grouping.
   */
  tags?: string[];
  /**
   * Optional accent color (hex string like "#5b8def") applied to the
   * connection's card and tag chips, so environments are easy to tell apart
   * at a glance. One of the curated CONNECTION_COLORS in the UI layer.
   */
  color?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MySqlConnectionConfig extends BaseConnectionConfig {
  engine: 'mysql';
  /** Default schema/database to inspect. */
  database?: string;
}

export interface MongoConnectionConfig extends BaseConnectionConfig {
  engine: 'mongodb';
  /** Auth database (defaults to "admin"). */
  authSource?: string;
  /** Target database to profile. */
  database?: string;
  replicaSet?: string;
}

export type ConnectionConfig = MySqlConnectionConfig | MongoConnectionConfig;

/**
 * Stable identifiers for a monitoring-capability problem. The UI maps each
 * code to actionable, copy-ready fix instructions (a GRANT statement, a config
 * change, etc.) so it never has to parse free-text messages. Add a new code
 * here when a connector learns to detect a new class of problem.
 */
export type CapabilityCode =
  // MySQL: performance_schema is off at the server level (needs my.cnf + restart).
  | 'mysql.performance_schema_disabled'
  // MySQL: the account cannot read the digest table we poll.
  | 'mysql.no_perfschema_select'
  // MongoDB: no target database configured, so we don't know what to profile.
  | 'mongo.no_target_database'
  // MongoDB: the account cannot read/manage the profiler on the target db.
  | 'mongo.no_profiling_access';

/** A single missing monitoring capability, detected by `connector.test()`. */
export interface CapabilityIssue {
  /** Stable code the UI maps to fix instructions. */
  code: CapabilityCode;
  /** Human-readable description; also a fallback if the UI lacks a mapping. */
  message: string;
}

/**
 * Result of a "Test Connection" action (before saving) or a capability
 * re-check of an already-saved connection.
 */
export interface ConnectionTestResult {
  ok: boolean;
  /** Round-trip latency of the test ping, in milliseconds. */
  latencyMs?: number;
  /** Server version string, e.g. "8.0.36" or "7.0.11". */
  serverVersion?: string;
  /** Whether the account has the privileges needed for monitoring. */
  monitoringCapable?: boolean;
  /**
   * Specific capabilities the connection is missing for monitoring, each with
   * a stable {@link CapabilityCode} the UI turns into a guided fix.
   */
  capabilityIssues?: CapabilityIssue[];
  error?: string;
}

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
