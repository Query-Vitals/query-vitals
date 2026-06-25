import type { IConnectionRepository } from '@main/domain/repositories';
import type {
  ConnectionConfig,
  MongoConnectionConfig,
  MySqlConnectionConfig,
  TlsConfig,
} from '@shared/types/database';
import type { Row, SqliteDatabase } from './database';

export class SqliteConnectionRepository implements IConnectionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<ConnectionConfig[]> {
    return this.db.all('SELECT * FROM connections ORDER BY name COLLATE NOCASE').map(toConfig);
  }

  async get(id: string): Promise<ConnectionConfig | null> {
    const row = this.db.get('SELECT * FROM connections WHERE id = ?', [id]);
    return row ? toConfig(row) : null;
  }

  async save(config: ConnectionConfig): Promise<ConnectionConfig> {
    const tls = config.tls ? JSON.stringify(config.tls) : null;
    const tags = config.tags && config.tags.length > 0 ? JSON.stringify(config.tags) : null;
    this.db.run(
      `INSERT INTO connections
        (id, name, engine, host, port, username, password_ref, database,
         auth_source, replica_set, tls, notes, tags, color, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, engine=excluded.engine, host=excluded.host,
         port=excluded.port, username=excluded.username,
         password_ref=excluded.password_ref, database=excluded.database,
         auth_source=excluded.auth_source, replica_set=excluded.replica_set,
         tls=excluded.tls, notes=excluded.notes, tags=excluded.tags,
         color=excluded.color, updated_at=excluded.updated_at`,
      [
        config.id,
        config.name,
        config.engine,
        config.host,
        config.port,
        config.username ?? null,
        config.passwordRef ?? null,
        config.database ?? null,
        config.engine === 'mongodb' ? (config.authSource ?? null) : null,
        config.engine === 'mongodb' ? (config.replicaSet ?? null) : null,
        tls,
        config.notes ?? null,
        tags,
        config.color ?? null,
        config.createdAt,
        config.updatedAt,
      ],
    );
    return config;
  }

  async delete(id: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.run('DELETE FROM query_history WHERE connection_id = ?', [id]);
      tx.run('DELETE FROM recommendations WHERE connection_id = ?', [id]);
      tx.run('DELETE FROM settings WHERE connection_id = ?', [id]);
      tx.run('DELETE FROM connections WHERE id = ?', [id]);
    });
  }
}

function toConfig(row: Row): ConnectionConfig {
  const tls = row['tls'] ? (JSON.parse(String(row['tls'])) as TlsConfig) : undefined;
  const tags = parseTags(row['tags']);
  const base = {
    id: String(row['id']),
    name: String(row['name']),
    host: String(row['host']),
    port: Number(row['port']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    ...(row['username'] != null ? { username: String(row['username']) } : {}),
    ...(row['password_ref'] != null ? { passwordRef: String(row['password_ref']) } : {}),
    ...(row['database'] != null ? { database: String(row['database']) } : {}),
    ...(row['notes'] != null ? { notes: String(row['notes']) } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(row['color'] != null ? { color: String(row['color']) } : {}),
    ...(tls ? { tls } : {}),
  };
  if (row['engine'] === 'mongodb') {
    const mongo: MongoConnectionConfig = {
      ...base,
      engine: 'mongodb',
      ...(row['auth_source'] != null ? { authSource: String(row['auth_source']) } : {}),
      ...(row['replica_set'] != null ? { replicaSet: String(row['replica_set']) } : {}),
    };
    return mongo;
  }
  const mysql: MySqlConnectionConfig = { ...base, engine: 'mysql' };
  return mysql;
}

/** Parse the stored tags column (a JSON string array) defensively. */
function parseTags(value: unknown): string[] {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) {
      return parsed.map((t) => String(t)).filter((t) => t.length > 0);
    }
  } catch {
    // Ignore malformed data and fall through to an empty list.
  }
  return [];
}
