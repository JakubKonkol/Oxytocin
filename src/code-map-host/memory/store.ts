import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { LearningSchema } from '@shared/domain/code-map-memory';
import { hasCode, rejectLink, safeDirectory } from '../store/paths';
import { atomicWrite, sha256 } from '../store/writer';

export const MEMORY_BYTES = 32 * 1024 * 1024;
export const MemoryFileSchema = z
  .object({
    format: z.literal('oxytocin.learnings'),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    checkoutId: z.string().min(1).max(200).optional(),
    records: z.array(LearningSchema).max(2000),
    history: z.array(LearningSchema).max(20000),
    retries: z
      .array(
        z
          .object({
            key: z.string(),
            digest: z.string(),
            id: z.string().optional(),
            revision: z.number(),
            at: z.number(),
            kind: z.enum(['proposal', 'feedback']).optional(),
            receiptKey: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(4096)
      .default([]),
  })
  .strict();
export type MemoryFile = z.infer<typeof MemoryFileSchema>;
export const emptyMemory = (): MemoryFile => ({
  format: 'oxytocin.learnings',
  schemaVersion: 1,
  revision: 0,
  records: [],
  history: [],
  retries: [],
});

async function read(path: string): Promise<MemoryFile | null> {
  await rejectLink(path);
  try {
    if ((await stat(path)).size > MEMORY_BYTES) throw new Error('MEMORY_LIMIT: learning store exceeds 32 MiB');
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof input === 'object' && input !== null && 'schemaVersion' in input && input.schemaVersion !== 1)
      throw new Error('INCOMPATIBLE_SCHEMA: preserve this store and migrate it before using memory');
    return MemoryFileSchema.parse(input);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** All replicas contain the latest committed state, including deletions. Never recover from an older revision. */
export function memorySegments(archiveId?: string): string[] {
  return ['.oxy', 'learnings', ...(archiveId ? ['archives', sha256(archiveId)] : [])];
}
function localSegments(archiveId?: string): string[] {
  return ['.oxy', 'learnings', 'local', ...(archiveId ? ['archives', sha256(archiveId)] : [])];
}
export async function listArchives(root: string): Promise<string[]> {
  let directory: string;
  try {
    directory = await safeDirectory(root, ['.oxy', 'learnings', 'archives'], false);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name))
      throw new Error('MEMORY_CORRUPT: invalid archive directory');
    const primary = join(await safeDirectory(directory, [entry.name], false), 'learnings.json');
    let file: MemoryFile | null = null;
    try {
      file = await read(primary);
    } catch (error) {
      if (String(error).includes('INCOMPATIBLE_SCHEMA')) throw error;
    }
    if (!file) {
      try {
        const local = await safeDirectory(root, ['.oxy', 'learnings', 'local', 'archives', entry.name], false);
        file = (await read(join(local, 'pending.json'))) ?? (await read(join(local, 'recovery.json')));
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
      if (!file) {
        const local = await safeDirectory(root, ['.oxy', 'learnings', 'local'], false);
        await rejectLink(join(local, 'transaction.json'));
        try {
          await stat(join(local, 'transaction.json'));
          continue;
        } catch (error) {
          throw new Error('MEMORY_CORRUPT: incomplete archive without a recovery transaction', { cause: error });
        }
      }
    }
    if (!file?.checkoutId || sha256(file.checkoutId) !== entry.name)
      throw new Error('MEMORY_CORRUPT: invalid archive identity');
    ids.push(file.checkoutId);
  }
  return ids.sort();
}
export async function loadMemory(root: string, archiveId?: string): Promise<MemoryFile> {
  let directory: string;
  try {
    directory = await safeDirectory(root, memorySegments(archiveId), false);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return emptyMemory();
    throw error;
  }
  let local: string | null = null;
  try {
    local = await safeDirectory(root, localSegments(archiveId), false);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  // Fail closed on an incompatible primary, even when a recovery file is available.
  let primary: MemoryFile | null = null;
  let failure: unknown;
  try {
    primary = await read(join(directory, 'learnings.json'));
  } catch (error) {
    if (String(error).includes('INCOMPATIBLE_SCHEMA')) throw error;
    failure = error;
  }
  const pending = local ? await read(join(local, 'pending.json')) : null;
  if (pending) {
    if (primary && pending.revision < primary.revision) throw new Error('RECOVERY_CONFLICT: older pending memory');
    await writeMemory(root, pending, archiveId);
    return pending;
  }
  if (!failure && primary) {
    // Retry/counter metadata is machine-local, never committed with the portable claims.
    if (local) {
      await rejectLink(join(local, 'metadata.json'));
      try {
        const metadata = z
          .object({
            revision: MemoryFileSchema.shape.revision,
            retries: MemoryFileSchema.shape.retries,
            feedback: z
              .array(z.object({ id: z.string(), revision: z.number(), value: LearningSchema.shape.feedback }).strict())
              .max(22000)
              .default([]),
          })
          .strict()
          .parse(JSON.parse(await readFile(join(local, 'metadata.json'), 'utf8')));
        if (metadata.revision === primary.revision) {
          primary.retries = metadata.retries;
          const counters = new Map(metadata.feedback.map((f) => [`${f.id}:${f.revision}`, f.value]));
          for (const record of [...primary.records, ...primary.history]) {
            const saved = counters.get(`${record.id}:${record.revision}`);
            if (saved) record.feedback = saved;
          }
        }
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
    return primary;
  }
  const recovery = local ? await read(join(local, 'recovery.json')) : null;
  if (recovery) {
    await writeMemory(root, recovery, archiveId);
    return recovery;
  }
  if (failure) throw new Error('MEMORY_CORRUPT: primary and recovery are unavailable', { cause: failure });
  return emptyMemory();
}

export async function writeMemory(root: string, input: MemoryFile, archiveId?: string): Promise<void> {
  const file = MemoryFileSchema.parse(input);
  file.records.sort((a, b) => a.id.localeCompare(b.id));
  const content = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(content) > MEMORY_BYTES)
    throw new Error('MEMORY_LIMIT: export and delete old learnings before adding more');
  const directory = await safeDirectory(root, memorySegments(archiveId));
  const local = await safeDirectory(root, localSegments(archiveId));
  await atomicWrite(join(local, 'pending.json'), content);
  await atomicWrite(join(local, 'recovery.json'), content);
  const { retries, ...portable } = file;
  const claim = ({ feedback: _feedback, ...record }: z.infer<typeof LearningSchema>) => record;
  await atomicWrite(
    join(directory, 'learnings.json'),
    `${JSON.stringify({ ...portable, records: file.records.map(claim), history: file.history.map(claim) }, null, 2)}\n`,
  );
  const feedback = [...file.records, ...file.history].map((r) => ({
    id: r.id,
    revision: r.revision,
    value: r.feedback,
  }));
  await atomicWrite(
    join(local, 'metadata.json'),
    `${JSON.stringify({ revision: file.revision, retries, feedback })}\n`,
  );
  await rm(join(local, 'pending.json'), { force: true });
  // A killed atomic rename can leave temporary content. Forget/delete must purge those copies too.
  for (const folder of [directory, local])
    for (const entry of await readdir(folder, { withFileTypes: true }))
      if (entry.isFile() && /^(learnings|recovery|pending|metadata)\.json\.tmp-/.test(entry.name))
        await rm(join(folder, entry.name), { force: true });
  await atomicWrite(join(local, '.gitignore'), '*\n');
  const oxy = await safeDirectory(root, ['.oxy']);
  const readme = join(oxy, 'README.md');
  await atomicWrite(
    readme,
    '# Oxytocin project data\n\n`code-map/` is regenerable. `learnings/` contains durable findings. Rebuild and Delete map data preserve learnings; use Forget all learnings to remove them.\n',
  );
  const ignore = join(oxy, '.gitignore');
  await rejectLink(ignore);
  try {
    await stat(ignore);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    await atomicWrite(ignore, '/learnings/local/\n*.tmp-*\n');
  }
}
