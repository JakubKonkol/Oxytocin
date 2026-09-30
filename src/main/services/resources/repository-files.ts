import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  applyManagedBlock,
  type ProjectResources,
  SHARED_CONFIG_PATH,
  type SharedProjectConfig,
  SharedProjectConfigSchema,
  sharedConfigOf,
} from '@shared/domain/project-resources';

export interface SharedConfigFile {
  config: SharedProjectConfig;
  /** Hash of the file's content: the user is asked again when it changes. */
  hash: string;
}

/** `.oxytocin/project.json` of a project (null when missing; an invalid file is reported as an error). */
export async function readSharedConfig(root: string): Promise<SharedConfigFile | null> {
  let text: string;
  try {
    text = await readFile(join(root, SHARED_CONFIG_PATH), 'utf8');
  } catch {
    return null;
  }
  const parsed = SharedProjectConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${SHARED_CONFIG_PATH} is not valid: ${parsed.error.issues[0]?.message ?? ''}`);
  return { config: parsed.data, hash: createHash('sha256').update(text).digest('hex').slice(0, 32) };
}

/** Writes the shareable resources (no secrets, no production hosts) to `.oxytocin/project.json`. */
export async function writeSharedConfig(root: string, resources: ProjectResources): Promise<string> {
  const path = join(root, SHARED_CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sharedConfigOf(resources), null, 2)}\n`);
  return path;
}

/**
 * Resources from the repository file that the project does not have yet (matched by id): local settings win, secrets
 * stay local. Relations and agent settings are not taken from the file.
 */
export function mergeSharedConfig(local: ProjectResources, shared: SharedProjectConfig): ProjectResources {
  const add = <T extends { id: string }>(mine: T[], theirs: T[]) => [
    ...mine,
    ...theirs.filter((t) => !mine.some((m) => m.id === t.id)),
  ];
  return {
    ...local,
    databases: add(local.databases, shared.resources.databases),
    apis: add(local.apis, shared.resources.apis),
    links: add(local.links, shared.resources.links),
    logs: add(local.logs, shared.resources.logs),
  };
}

/**
 * Writes the managed resources block into AGENTS.md / CLAUDE.md (created when missing). Returns false when the file
 * already had exactly this content (nothing written, so the Changes panel stays quiet).
 */
export async function writeInstructionsBlock(
  root: string,
  file: 'AGENTS.md' | 'CLAUDE.md',
  body: string,
): Promise<{ path: string; written: boolean }> {
  const path = join(root, file);
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    if (!body) return { path, written: false };
  }
  const next = applyManagedBlock(current, body);
  if (next === current) return { path, written: false };
  await writeFile(path, next);
  return { path, written: true };
}
