import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export interface StatManyResult {
  path: string;
  resolved: string | null;
  isFile: boolean;
}

/**
 * Resolves candidate paths (from terminal file links) against base directories: absolute paths as-is,
 * relative ones against each base dir in order. Only existence information is returned. `resolved` is the real path
 * (Windows 8.3 short names such as `RUNNER~1`, symlinks and junctions resolved), so it compares with project roots.
 */
export async function statMany(baseDirs: readonly string[], paths: readonly string[]): Promise<StatManyResult[]> {
  return Promise.all(
    paths.map(async (path) => {
      const candidates = isAbsolute(path) ? [path] : baseDirs.map((d) => resolve(d, path));
      for (const candidate of candidates) {
        try {
          const s = await stat(candidate);
          const real = await realpath(candidate).catch(() => candidate);
          return { path, resolved: real, isFile: s.isFile() };
        } catch {
          // try the next base dir
        }
      }
      return { path, resolved: null, isFile: false };
    }),
  );
}
