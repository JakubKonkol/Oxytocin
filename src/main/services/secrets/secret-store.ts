import { z } from 'zod';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import type { SecretsStatus } from '@shared/domain/project-resources';
import { JsonFileStore } from '../storage/json-file-store';

/** The part of Electron's `safeStorage` the store uses (only usable in main after `app.whenReady()`). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: `basic_text` means no keyring (secrets are only obfuscated). */
  getSelectedStorageBackend?(): string;
  /** Linux only: allow the `basic_text` backend (no keyring) instead of refusing to encrypt. */
  setUsePlainTextEncryption?(usePlainText: boolean): void;
}

const SecretsFileSchema = z.object({
  version: z.literal(1),
  /** `<projectId>/<resourceId>/<key>` → base64 ciphertext. */
  secrets: z.record(z.string(), z.string()),
});
type SecretsFile = z.infer<typeof SecretsFileSchema>;

const id = (projectId: string, resourceId: string, key: string) => `${projectId}/${resourceId}/${key}`;

/**
 * Passwords, tokens and connection URLs of project resources, encrypted with the OS key (DPAPI on Windows, Keychain
 * on macOS, libsecret/kwallet on Linux) in `secrets.json`. Plaintext only leaves this class to go to the Connections
 * Host for one call; the renderer can only write secrets and ask which ones are set.
 */
export class SecretStore {
  private readonly store: JsonFileStore<SecretsFile>;

  constructor(
    file: string,
    private readonly safe: SafeStorageLike,
    private readonly logger: Logger,
  ) {
    this.store = new JsonFileStore({
      path: file,
      schema: SecretsFileSchema,
      defaults: () => ({ version: 1, secrets: {} }),
      debounceMs: 0,
      backup: true,
      logger,
    });
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  private backend(): string {
    try {
      return this.safe.getSelectedStorageBackend?.() ?? (process.platform === 'win32' ? 'dpapi' : 'keychain');
    } catch {
      return 'unknown';
    }
  }

  status(projectId: string): SecretsStatus {
    const prefix = `${projectId}/`;
    const backend = this.backend();
    return {
      stored: Object.keys(this.store.get().secrets)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length)),
      backend,
      encrypted: backend !== 'basic_text' && this.safe.isEncryptionAvailable(),
    };
  }

  /**
   * Whether secrets can be stored. On Linux without a keyring Electron only offers `basic_text` (obfuscation): it is
   * accepted, and the dialog warns about it.
   */
  private available(): boolean {
    if (this.safe.isEncryptionAvailable()) return true;
    if (this.backend() !== 'basic_text' || !this.safe.setUsePlainTextEncryption) return false;
    this.safe.setUsePlainTextEncryption(true);
    return this.safe.isEncryptionAvailable();
  }

  async set(projectId: string, resourceId: string, key: string, value: string): Promise<void> {
    if (!this.available())
      throw new OxyError('UNAVAILABLE', 'Secrets cannot be stored: the operating system keychain is not available.');
    const encrypted = this.safe.encryptString(value).toString('base64');
    this.store.update((s) => ({ ...s, secrets: { ...s.secrets, [id(projectId, resourceId, key)]: encrypted } }));
    await this.store.flush();
  }

  async delete(projectId: string, resourceId: string, key: string): Promise<void> {
    await this.deleteWhere((k) => k === id(projectId, resourceId, key));
  }

  /** Every secret of a resource, decrypted (main process only). */
  getAll(projectId: string, resourceId: string): Record<string, string> {
    const prefix = `${projectId}/${resourceId}/`;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.store.get().secrets)) {
      if (!k.startsWith(prefix)) continue;
      try {
        out[k.slice(prefix.length)] = this.safe.decryptString(Buffer.from(v, 'base64'));
      } catch {
        // Encrypted with another OS key (a copied profile) or corrupt: treated as not set.
        this.logger.warn(`A secret of resource ${resourceId} could not be decrypted; enter it again.`);
      }
    }
    return out;
  }

  /** Removes the secrets of resources that no longer exist in a project (or of the whole project). */
  async retain(projectId: string, resourceIds: ReadonlySet<string> | null): Promise<void> {
    await this.deleteWhere((k) => {
      if (!k.startsWith(`${projectId}/`)) return false;
      return resourceIds === null || !resourceIds.has(k.slice(projectId.length + 1).split('/')[0]!);
    });
  }

  private async deleteWhere(predicate: (key: string) => boolean): Promise<void> {
    const current = this.store.get().secrets;
    const kept = Object.fromEntries(Object.entries(current).filter(([k]) => !predicate(k)));
    if (Object.keys(kept).length === Object.keys(current).length) return;
    this.store.set({ version: 1, secrets: kept });
    await this.store.flush();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
