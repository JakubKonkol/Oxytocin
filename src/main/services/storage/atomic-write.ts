import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETRY_DELAYS_MS = [50, 150, 400];
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomic write: temp file → fsync → rename. On Windows rename may fail with EPERM/EBUSY
 * (antivirus, indexer), so it is retried with backoff.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      const delay = RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE.has(code) || delay === undefined) {
        await rm(tmp, { force: true });
        throw e;
      }
      await sleep(delay);
    }
  }
}
