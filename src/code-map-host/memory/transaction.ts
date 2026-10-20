import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hasCode, rejectLink, safeDirectory } from '../store/paths';
import { atomicWrite } from '../store/writer';
import { MEMORY_BYTES, MemoryFileSchema, writeMemory, type MemoryFile } from './store';
import { reserveMemory, type MemoryLocation } from './locations';

const Transaction = z
  .array(z.object({ checkoutId: z.string().min(1).max(200), archived: z.boolean(), file: MemoryFileSchema }).strict())
  .max(1001);
async function cleanup(directory: string): Promise<void> {
  await rm(join(directory, 'transaction.json'), { force: true });
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isFile() && entry.name.startsWith('transaction.json.tmp-'))
      await rm(join(directory, entry.name), { force: true });
}
/** Resolve identities against main's current authorized locations. A journal never authorizes a filesystem root. */
export async function replayTransaction(root: string, locations: MemoryLocation[]): Promise<void> {
  const directory = await safeDirectory(root, ['.oxy', 'learnings', 'local']);
  const path = join(directory, 'transaction.json');
  await rejectLink(path);
  let input: unknown;
  try {
    if ((await stat(path)).size > MEMORY_BYTES + 1024 * 1024) throw new Error('MEMORY_CORRUPT: oversized transaction');
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  const transaction = Transaction.parse(input);
  const targets = transaction.map((entry) => {
    const location =
      locations.find((l) => l.checkoutId === entry.checkoutId && !!l.archiveId === entry.archived) ??
      (entry.archived ? { checkoutId: entry.checkoutId, root, archiveId: entry.checkoutId } : undefined);
    if (!location) throw new Error('MEMORY_UNAVAILABLE: restore the transaction checkout before repairing memory');
    return { location, file: entry.file };
  });
  for (const { location, file } of targets) await writeMemory(location.root, file, location.archiveId);
  await cleanup(directory);
}
/** Called with all checkout leases held. Pending publication is replayed before any subsequent read or mutation. */
export async function commitMemory(
  root: string,
  stores: Map<MemoryLocation, MemoryFile>,
  dirty: Set<MemoryLocation>,
): Promise<void> {
  const finalize = await reserveMemory(root, stores);
  const directory = await safeDirectory(root, ['.oxy', 'learnings', 'local']);
  const transaction = Transaction.parse(
    [...dirty].map((location) => ({
      checkoutId: location.checkoutId,
      archived: !!location.archiveId,
      file: stores.get(location)!,
    })),
  );
  await atomicWrite(join(directory, 'transaction.json'), `${JSON.stringify(transaction)}\n`);
  for (const location of dirty) await writeMemory(location.root, stores.get(location)!, location.archiveId);
  await finalize();
  await cleanup(directory);
}
