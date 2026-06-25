import type { IRecommendationRepository } from '@main/domain/repositories';
import type { Recommendation, IndexField } from '@shared/types/recommendation';
import type { DatabaseEngine } from '@shared/types/database';
import type { Row, SqliteDatabase } from './database';

export class SqliteRecommendationRepository implements IRecommendationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async upsertMany(recs: Recommendation[]): Promise<void> {
    this.db.transaction((tx) => {
      for (const r of recs) {
        tx.run(
          `INSERT INTO recommendations
            (id, connection_id, engine, kind, severity, database_name, target_name,
             fields, ddl, rationale, estimated_impact, source_fingerprints,
             created_at, dismissed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(connection_id, ddl) DO UPDATE SET
             severity=excluded.severity,
             rationale=excluded.rationale,
             estimated_impact=excluded.estimated_impact,
             source_fingerprints=excluded.source_fingerprints`,
          [
            r.id,
            r.connectionId,
            r.engine,
            r.kind,
            r.severity,
            r.databaseName,
            r.targetName,
            JSON.stringify(r.fields),
            r.ddl,
            r.rationale,
            r.estimatedImpact ?? null,
            JSON.stringify(r.sourceFingerprints),
            r.createdAt,
            r.dismissed ? 1 : 0,
          ],
        );
      }
    });
  }

  async listActive(connectionId: string): Promise<Recommendation[]> {
    return this.db
      .all(
        'SELECT * FROM recommendations WHERE connection_id = ? AND dismissed = 0 ORDER BY created_at DESC',
        [connectionId],
      )
      .map(toRecommendation);
  }

  async dismiss(id: string): Promise<void> {
    this.db.run('UPDATE recommendations SET dismissed = 1 WHERE id = ?', [id]);
  }
}

function toRecommendation(row: Row): Recommendation {
  return {
    id: String(row['id']),
    connectionId: String(row['connection_id']),
    engine: String(row['engine']) as DatabaseEngine,
    kind: String(row['kind']) as Recommendation['kind'],
    severity: String(row['severity']) as Recommendation['severity'],
    databaseName: String(row['database_name']),
    targetName: String(row['target_name']),
    fields: JSON.parse(String(row['fields'])) as IndexField[],
    ddl: String(row['ddl']),
    rationale: String(row['rationale']),
    sourceFingerprints: JSON.parse(String(row['source_fingerprints'])) as string[],
    createdAt: String(row['created_at']),
    dismissed: Number(row['dismissed']) === 1,
    ...(row['estimated_impact'] != null
      ? { estimatedImpact: String(row['estimated_impact']) }
      : {}),
  };
}
