import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '@shared/logging/logger';
import { type SafeStorageLike, SecretStore } from './secret-store';

const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

/** A reversible fake "encryption" (the real one is Electron's safeStorage). */
const fakeSafe = (available = true, backend = 'gnome_libsecret'): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
  getSelectedStorageBackend: () => backend,
});

describe('SecretStore', () => {
  it('stores encrypted secrets and reports only which are set', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'oxy-secrets-')), 'secrets.json');
    const store = new SecretStore(file, fakeSafe(), silentLogger);
    await store.load();
    await store.set('p1', 'db1', 'password', 'hunter2');
    await store.set('p1', 'api1', 'header:X-Key', 'k');
    await store.set('p2', 'db1', 'url', 'postgres://x');
    expect(await readFile(file, 'utf8')).not.toContain('hunter2');
    expect(store.status('p1')).toEqual({
      stored: ['db1/password', 'api1/header:X-Key'],
      backend: 'gnome_libsecret',
      encrypted: true,
    });
    expect(store.getAll('p1', 'db1')).toEqual({ password: 'hunter2' });

    const reloaded = new SecretStore(file, fakeSafe(), silentLogger);
    await reloaded.load();
    expect(reloaded.getAll('p2', 'db1')).toEqual({ url: 'postgres://x' });

    await reloaded.delete('p1', 'db1', 'password');
    await reloaded.retain('p1', new Set(['db1']));
    expect(reloaded.status('p1').stored).toEqual([]);
    await reloaded.retain('p2', null);
    expect(reloaded.status('p2').stored).toEqual([]);
  });

  it('warns about basic_text and refuses to store without encryption', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'oxy-secrets-')), 'secrets.json');
    expect(new SecretStore(file, fakeSafe(true, 'basic_text'), silentLogger).status('p').encrypted).toBe(false);
    // Linux without a keyring: basic_text is allowed (obfuscation) after opting in.
    let plain = false;
    const linux = new SecretStore(
      file,
      {
        ...fakeSafe(false, 'basic_text'),
        isEncryptionAvailable: () => plain,
        setUsePlainTextEncryption: (v) => (plain = v),
      },
      silentLogger,
    );
    await linux.set('p', 'r', 'password', 'x');
    expect(linux.getAll('p', 'r')).toEqual({ password: 'x' });
    const none = new SecretStore(file, fakeSafe(false), silentLogger);
    await expect(none.set('p', 'r', 'password', 'x')).rejects.toThrow(/keychain/);
  });

  it('treats secrets it cannot decrypt as not set', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'oxy-secrets-')), 'secrets.json');
    const store = new SecretStore(
      file,
      {
        ...fakeSafe(),
        decryptString: () => {
          throw new Error('bad key');
        },
      },
      silentLogger,
    );
    await store.set('p', 'r', 'password', 'x');
    expect(store.getAll('p', 'r')).toEqual({});
  });
});
