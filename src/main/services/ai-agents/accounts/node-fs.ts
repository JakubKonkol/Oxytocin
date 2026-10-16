import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { EntryKind, ProvisionFs } from './provisioner';

/** The provisioning's file system on this computer. */
export const nodeProvisionFs: ProvisionFs = {
  async kind(path): Promise<EntryKind> {
    try {
      const s = await lstat(path);
      if (s.isSymbolicLink()) return 'link';
      return s.isDirectory() ? 'dir' : 'file';
    } catch {
      return 'missing';
    }
  },
  async readlink(path) {
    try {
      return await readlink(path);
    } catch {
      return null;
    }
  },
  async mkdir(path, mode) {
    await mkdir(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
  },
  async symlink(target, path, type) {
    await symlink(target, path, type);
  },
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async writeText(path, text) {
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  },
  async unlink(path) {
    await unlink(path);
  },
  async removeTree(path) {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  },
};

/** macOS: deletes a generic password of the login Keychain (absent: nothing to do). */
export function deleteKeychainEntry(service: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('security', ['delete-generic-password', '-s', service], { timeout: 10_000 }, () => resolve());
  });
}
