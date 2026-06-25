import { describe, it, expect } from 'vitest';
import { QueryAnalyzer } from './query-analyzer';
import type { RawObservedQuery } from '@main/domain/services/database-connector';

const analyzer = new QueryAnalyzer();

function rawMongo(command: object, databaseName = 'app'): RawObservedQuery {
  return {
    rawQuery: JSON.stringify(command),
    databaseName,
    executionTimeMs: 1,
    timestamp: new Date().toISOString(),
  };
}

describe('QueryAnalyzer.normalize (MongoDB)', () => {
  it('extracts query type and target collection from a find command', () => {
    const n = analyzer.normalize(
      rawMongo({ find: 'users', filter: { status: 'active' }, sort: { createdAt: -1 } }),
      'mongodb',
    );
    expect(n.queryType).toBe('find');
    expect(n.targetName).toBe('users');
  });

  it('gives the same fingerprint regardless of literal values', () => {
    const a = analyzer.normalize(
      rawMongo({ find: 'users', filter: { status: 'active', age: { $gt: 21 } } }),
      'mongodb',
    );
    const b = analyzer.normalize(
      rawMongo({ find: 'users', filter: { status: 'banned', age: { $gt: 99 } } }),
      'mongodb',
    );
    expect(a.normalizedQuery).toBe(b.normalizedQuery);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('collapses $in lists of different lengths to one fingerprint', () => {
    const a = analyzer.normalize(rawMongo({ find: 'p', filter: { id: { $in: [1, 2, 3] } } }), 'mongodb');
    const b = analyzer.normalize(rawMongo({ find: 'p', filter: { id: { $in: [9] } } }), 'mongodb');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('keeps fingerprints distinct across collections and key order', () => {
    const users = analyzer.normalize(rawMongo({ find: 'users', filter: { a: 1 } }), 'mongodb');
    const orders = analyzer.normalize(rawMongo({ find: 'orders', filter: { a: 1 } }), 'mongodb');
    expect(users.fingerprint).not.toBe(orders.fingerprint);

    // Key order within the filter must not change the fingerprint.
    const ab = analyzer.normalize(rawMongo({ find: 'u', filter: { a: 1, b: 2 } }), 'mongodb');
    const ba = analyzer.normalize(rawMongo({ find: 'u', filter: { b: 2, a: 1 } }), 'mongodb');
    expect(ab.normalizedQuery).toBe(ba.normalizedQuery);
  });

  it('maps aggregate and collects $lookup targets', () => {
    const n = analyzer.normalize(
      rawMongo({
        aggregate: 'orders',
        pipeline: [
          { $match: { status: 'paid' } },
          { $lookup: { from: 'customers', localField: 'cid', foreignField: '_id', as: 'c' } },
        ],
      }),
      'mongodb',
    );
    expect(n.queryType).toBe('aggregate');
    expect(n.targetName).toBe('orders');
    expect(n.relatedTargets).toContain('customers');
  });

  it('still normalizes SQL when the engine is mysql', () => {
    const n = analyzer.normalize(
      { rawQuery: 'SELECT * FROM t WHERE id = 5', databaseName: 'db', executionTimeMs: 1, timestamp: '' },
      'mysql',
    );
    expect(n.queryType).toBe('select');
    expect(n.normalizedQuery).toContain('?');
  });
});
