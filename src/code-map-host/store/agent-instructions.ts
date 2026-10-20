import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { codeMapInstructionBlock } from '@shared/domain/code-map-instructions';
import { hasCode, rejectLink } from './paths';
import { atomicWrite, sha256 } from './writer';
import { fingerprint } from '../fingerprint';

/** Called only for a root authorized by main and an explicit user action. Never called by indexing. */
export async function editAgentInstructions(
  root: string,
  file: 'CLAUDE.md' | 'AGENTS.md',
  action: 'add' | 'remove',
): Promise<{ changed: boolean }> {
  const canonicalRoot = await realpath(root);
  const path = join(canonicalRoot, file);
  await rejectLink(path);
  const info = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (info && (!info.isFile() || info.size > 256 * 1024))
    throw new Error('Agent instructions must be a regular file under 256 KiB');
  const read = async () => {
    await rejectLink(path);
    const value = await fingerprint(canonicalRoot, file).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    });
    await rejectLink(path);
    if (value && Buffer.byteLength(value.source) > 256 * 1024) throw new Error('Agent instructions exceed 256 KiB');
    // Writing back a lossy decoding would replace every byte that is not UTF-8.
    if (value && sha256(Buffer.from(value.source, 'utf8')) !== value.fingerprint.sha256)
      throw new Error('Agent instructions must be UTF-8 text');
    return value?.source ?? null;
  };
  const before = info ? await read() : null;
  const after = codeMapInstructionBlock(before, action);
  if (after && Buffer.byteLength(after) > 256 * 1024) throw new Error('Agent instructions exceed 256 KiB');
  if (before === after) return { changed: false };
  await rejectLink(path);
  const current = await read();
  if (current !== before) throw new Error('Agent instructions changed during the operation; retry.');
  if (after === null) await unlink(path);
  else {
    await atomicWrite(path, after);
    // The temporary file is private; keep the permissions of the file it replaces.
    await chmod(path, info ? info.mode & 0o7777 : 0o644);
  }
  return { changed: true };
}
