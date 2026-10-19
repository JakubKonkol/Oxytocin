import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve each component, including junctions, before using an Oxytocin-owned directory. */
export async function safeDirectory(root: string, segments: readonly string[], create = true): Promise<string> {
  const canonicalRoot = await realpath(root);
  let boundary = canonicalRoot;
  let path = canonicalRoot;
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      /[\\/]/.test(segment) ||
      segment.includes(String.fromCharCode(0))
    )
      throw new Error('Invalid data path');
    path = join(path, segment);
    if (create)
      await mkdir(path).catch((error: unknown) => {
        if (!hasCode(error, 'EEXIST')) throw error;
      });
    path = await realpath(path);
    if (!isInside(boundary, path)) throw new Error('Code Map data path escapes its directory');
    if (!(await lstat(path)).isDirectory()) throw new Error('Code Map data path is not a directory');
    boundary = path;
  }
  return path;
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function rejectLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing to access a symbolic link');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}
