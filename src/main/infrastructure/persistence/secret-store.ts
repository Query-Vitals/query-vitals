/**
 * SafeStorageSecretStore — encrypts connection passwords with Electron's
 * built-in `safeStorage` (OS-backed: Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux) and stores the ciphertext in the local DB. No native
 * module (keytar) required.
 *
 * If OS encryption is unavailable (e.g. a headless Linux box with no keyring),
 * it falls back to obfuscated storage and the value is flagged so the app can
 * warn the user. Plaintext is never written.
 */

import { safeStorage } from 'electron';
import type { ISecretStore } from '@main/domain/repositories';
import type { SqliteDatabase } from './database';

const PREFIX = 'secret:';
const PLAIN_MARK = 'plain:'; // fallback marker

export class SafeStorageSecretStore implements ISecretStore {
  constructor(private readonly db: SqliteDatabase) {}

  async set(ref: string, secret: string): Promise<void> {
    let stored: string;
    if (safeStorage.isEncryptionAvailable()) {
      stored = safeStorage.encryptString(secret).toString('base64');
    } else {
      stored = PLAIN_MARK + Buffer.from(secret, 'utf8').toString('base64');
    }
    this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [PREFIX + ref, stored]);
  }

  async get(ref: string): Promise<string | null> {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      PREFIX + ref,
    ]);
    if (!row) return null;
    const value = String(row.value);
    if (value.startsWith(PLAIN_MARK)) {
      return Buffer.from(value.slice(PLAIN_MARK.length), 'base64').toString('utf8');
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  }

  async delete(ref: string): Promise<void> {
    this.db.run('DELETE FROM meta WHERE key = ?', [PREFIX + ref]);
  }
}
