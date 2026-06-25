/**
 * SqliteDatabase — a thin synchronous wrapper around sql.js (SQLite compiled to
 * WebAssembly). Chosen over a native module (better-sqlite3) so the app installs
 * with zero node-gyp/compilation on any Node or Electron version.
 *
 * Model: sql.js keeps the database in memory. We load the file on open and
 * persist it back to disk with a debounced `db.export()` after writes. For a
 * local query-history tool this is simple and fast; the whole DB is small.
 *
 * Everything here stays behind the repository interfaces in
 * `src/main/domain/repositories` — no other layer imports sql.js.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js';

const require = createRequire(import.meta.url);

export type { SqlValue };
export type Row = Record<string, SqlValue>;
export type Params = SqlValue[] | Record<string, SqlValue>;

export class SqliteDatabase {
  private db: SqlJsDatabase | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor(
    private readonly db_: SqlJsDatabase,
    private readonly filePath: string,
    private readonly saveDebounceMs: number,
  ) {
    this.db = db_;
  }

  /** Open (or create) the database file and initialize the WASM runtime. */
  static async open(filePath: string, saveDebounceMs = 400): Promise<SqliteDatabase> {
    const SQL = await initSqlJs({
      // Resolve the .wasm next to the sql.js package so it works packaged + in dev.
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    });
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = existsSync(filePath) ? new SQL.Database(readFileSync(filePath)) : new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');
    return new SqliteDatabase(db, filePath, saveDebounceMs);
  }

  /** Run a statement that returns no rows (INSERT/UPDATE/DDL). */
  run(sql: string, params: Params = []): void {
    // sql.js takes two paths in Database.run(sql, params): when `params` is
    // truthy it prepares a single statement (executing ONLY the first statement
    // of the script); when falsy it uses sqlite3_exec (executing ALL
    // statements). An empty `[]`/`{}` is truthy, so passing it for a
    // multi-statement DDL script would silently run only the first CREATE TABLE.
    // Only forward params when there actually are some.
    const hasParams = Array.isArray(params)
      ? params.length > 0
      : Object.keys(params).length > 0;
    if (hasParams) {
      this.handle().run(sql, params as never);
    } else {
      this.handle().run(sql);
    }
    this.markDirty();
  }

  /** Run a query and return all rows. */
  all<T extends Row = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.handle().prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  /** Run a query and return the first row, or null. */
  get<T extends Row = Row>(sql: string, params: Params = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  /** Run several statements in a single transaction. */
  transaction(fn: (db: this) => void): void {
    this.handle().run('BEGIN');
    try {
      fn(this);
      this.handle().run('COMMIT');
    } catch (err) {
      this.handle().run('ROLLBACK');
      throw err;
    }
    this.markDirty();
  }

  /** Persist immediately (used on app quit). Atomic write via temp + rename. */
  flush(): void {
    if (!this.dirty || !this.db) return;
    const data = Buffer.from(this.db.export());
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.flush();
    this.db?.close();
    this.db = null;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDebounceMs);
  }

  private handle(): SqlJsDatabase {
    if (!this.db) throw new Error('SqliteDatabase is closed');
    return this.db;
  }
}
