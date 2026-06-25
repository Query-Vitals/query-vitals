/** Builds the correct engine adapter from a connection config. */

import type { IConnectorFactory, IDatabaseConnector } from '@main/domain/services/database-connector';
import type { ConnectionConfig } from '@shared/types/database';
import { MySqlConnector } from './mysql/mysql-connector';
import { MongoConnector } from './mongodb/mongo-connector';

export class ConnectorFactory implements IConnectorFactory {
  create(config: ConnectionConfig, password: string | null): IDatabaseConnector {
    switch (config.engine) {
      case 'mysql':
        return new MySqlConnector(config, password);
      case 'mongodb':
        return new MongoConnector(config, password);
      default: {
        // Exhaustiveness guard: a new engine must be handled here.
        const _never: never = config;
        throw new Error(`Unsupported engine: ${JSON.stringify(_never)}`);
      }
    }
  }
}
