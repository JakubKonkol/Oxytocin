import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { LearningSchema } from '@shared/domain/code-map-memory';
import { hasCode, rejectLink, safeDirectory } from '../store/paths';
import { atomicWrite } from '../store/writer';

export const MEMORY_BYTES = 32 * 1024 * 1024;
export const MemoryFileSchema = z
  .object({
    format: z.literal('oxytocin.learnings'),
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
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
          })
          .strict(),
      )
      .max(4096),
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
export async function loadMemory(root: string): Promise<MemoryFile> {
  let directory: string;
  try {
    directory = await safeDirectory(root, ['.oxy', 'learnings'], false);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return emptyMemory();
    throw error;
  }
  let local: string | null = null;
  try {
    local = await safeDirectory(root, ['.oxy', 'learnings', 'local'], false);
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
    await writeMemory(root, pending);
    return pending;
  }
  if (!failure && primary) return primary;
  const recovery = local ? await read(join(local, 'recovery.json')) : null;
  if (recovery) {
    await writeMemory(root, recovery);
    return recovery;
  }
  if (failure) throw new Error('MEMORY_CORRUPT: primary and recovery are unavailable', { cause: failure });
  return emptyMemory();
}

export async function writeMemory(root: string, input: MemoryFile): Promise<void> {
  const file = MemoryFileSchema.parse(input);
  file.records.sort((a, b) => a.id.localeCompare(b.id));
  const content = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(content) > MEMORY_BYTES)
    throw new Error('MEMORY_LIMIT: export and delete old learnings before adding more');
  const directory = await safeDirectory(root, ['.oxy', 'learnings']);
  const local = await safeDirectory(root, ['.oxy', 'learnings', 'local']);
  await atomicWrite(join(local, 'pending.json'), content);
  await atomicWrite(join(local, 'recovery.json'), content);
  await atomicWrite(join(directory, 'learnings.json'), content);
  await rm(join(local, 'pending.json'), { force: true });
  // A killed atomic rename can leave temporary content. Forget/delete must purge those copies too.
  for (const folder of [directory, local])
    for (const entry of await readdir(folder, { withFileTypes: true }))
      if (entry.isFile() && /^(learnings|recovery|pending)\.json\.tmp-/.test(entry.name))
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
