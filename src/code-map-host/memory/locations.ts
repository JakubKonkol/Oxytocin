import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MemoryAuthority } from '@shared/domain/code-map-memory';
import { hasCode, rejectLink, safeDirectory } from '../store/paths';
import { atomicWrite } from '../store/writer';
import { listArchives, MEMORY_BYTES, type MemoryFile } from './store';

const Usage = z
  .array(
    z
      .object({
        checkoutId: z.string().min(1).max(200),
        records: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .max(1000);
export interface MemoryLocation {
  checkoutId: string;
  root: string;
  archiveId?: string;
}

/** Read paths come only from main's current authority, never from a persisted absolute path. */
export async function memoryLocations(authority: MemoryAuthority): Promise<MemoryLocation[]> {
  const archived = await listArchives(authority.projectRoot);
  const roots = new Map<string, string>();
  for (const checkout of authority.checkouts) {
    const root = await realpath(checkout.root);
    const previous = roots.get(checkout.checkoutId);
    if (previous && previous !== root) throw new Error('CHECKOUT_CHANGED: learning identity is bound to another root');
    roots.set(checkout.checkoutId, root);
  }
  const live = [...roots].filter(([id]) => !archived.includes(id)).map(([checkoutId, root]) => ({ checkoutId, root }));
  return [
    ...live,
    ...archived.map((checkoutId) => ({ checkoutId, root: authority.projectRoot, archiveId: checkoutId })),
  ];
}

/** Reserve before publication; release only after it. A crash can overcount, never grant an extra budget. */
export async function reserveMemory(
  root: string,
  stores: Map<MemoryLocation, MemoryFile>,
): Promise<() => Promise<void>> {
  const local = await safeDirectory(root, ['.oxy', 'learnings', 'local']);
  const path = join(local, 'usage.json');
  await rejectLink(path);
  let previous: z.infer<typeof Usage> = [];
  try {
    previous = Usage.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const usage = new Map(previous.map((u) => [u.checkoutId, u]));
  for (const [location, file] of stores)
    usage.set(location.checkoutId, {
      checkoutId: location.checkoutId,
      records: file.records.length,
      bytes: Buffer.byteLength(JSON.stringify(file, null, 2)) + 1,
    });
  const current = Usage.parse([...usage.values()].sort((a, b) => a.checkoutId.localeCompare(b.checkoutId)));
  if (current.reduce((n, u) => n + u.records, 0) > 2000 || current.reduce((n, u) => n + u.bytes, 0) > MEMORY_BYTES)
    throw new Error(
      'MEMORY_LIMIT: export and remove learnings or old revisions in the checkout manager before adding more',
    );
  const reserved = current.map((u) => {
    const old = previous.find((p) => p.checkoutId === u.checkoutId);
    return { ...u, records: Math.max(u.records, old?.records ?? 0), bytes: Math.max(u.bytes, old?.bytes ?? 0) };
  });
  await atomicWrite(path, `${JSON.stringify(reserved)}\n`);
  return () => atomicWrite(path, `${JSON.stringify(current)}\n`);
}
