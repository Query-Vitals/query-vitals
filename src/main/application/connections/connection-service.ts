import type {
  IConnectionRepository,
  ISecretStore,
} from '@main/domain/repositories';
import type { IConnectorFactory } from '@main/domain/services/database-connector';
import type {
  ConnectionConfig,
  ConnectionTestResult,
} from '@shared/types/database';

export class ConnectionService {
  constructor(
    private readonly repo: IConnectionRepository,
    private readonly secrets: ISecretStore,
    private readonly factory: IConnectorFactory,
  ) {}

  list(): Promise<ConnectionConfig[]> {
    return this.repo.list();
  }

  /** Test before saving — password is the plaintext entered in the form. */
  test(config: ConnectionConfig, password: string | null): Promise<ConnectionTestResult> {
    return this.factory.create(config, password).test();
  }

  /**
   * Re-check an already-saved connection's monitoring capabilities, resolving
   * its stored secret the same way the collector does. Lets the monitoring
   * screen show a preflight before starting, without re-asking for a password.
   */
  async capabilities(connectionId: string): Promise<ConnectionTestResult> {
    const config = await this.repo.get(connectionId);
    if (!config) return { ok: false, error: 'Connection not found' };
    const password = config.passwordRef ? await this.secrets.get(config.passwordRef) : null;
    return this.factory.create(config, password).test();
  }

  async save(config: ConnectionConfig, password?: string): Promise<ConnectionConfig> {
    const now = new Date().toISOString();
    const next: ConnectionConfig = { ...config, updatedAt: now };
    if (!next.createdAt) next.createdAt = now;

    if (password) {
      const ref = config.passwordRef ?? `conn:${config.id}`;
      await this.secrets.set(ref, password);
      next.passwordRef = ref;
    }
    return this.repo.save(next);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.repo.get(id);
    if (existing?.passwordRef) await this.secrets.delete(existing.passwordRef);
    await this.repo.delete(id);
  }
}
