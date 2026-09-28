import { realpath } from 'node:fs/promises';

/**
 * Paths agents report in other spellings: Git Bash / MSYS (`/c/work/app`) and WSL (`/mnt/c/work/app`) on Windows
 * become `C:\work\app`. Other paths are returned unchanged.
 */
export function fromShellPath(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return path;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(\/.*)?$/.exec(path);
  if (!m) return path;
  return `${m[1]!.toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}`;
}

/**
 * Spellings of `path` to look a project up with: as given, converted from a shell path, and the real path (Windows
 * 8.3 short names such as `C:\Users\RUNNER~1`, symlinks and junctions resolved; project roots are stored real).
 */
export async function pathCandidates(path: string, platform: NodeJS.Platform): Promise<string[]> {
  const converted = fromShellPath(path.trim(), platform);
  const out = [path.trim(), converted];
  const real = await realpath(converted).catch(() => null);
  if (real) out.push(real);
  return [...new Set(out)];
}
