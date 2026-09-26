import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export interface StatManyResult {
  path: string;
  resolved: string | null;
  isFile: boolean;
}

/**
 * Resolves candidate paths (from terminal file links) against base directories: absolute paths as-is,
 * relative ones against each base dir in order. Only existence information is returned.
 */
export async function statMany(baseDirs: readonly string[], paths: readonly string[]): Promise<StatManyResult[]> {
  return Promise.all(
    paths.map(async (path) => {
      const candidates = isAbsolute(path) ? [path] : baseDirs.map((d) => resolve(d, path));
      for (const candidate of candidates) {
        try {
          const s = await stat(candidate);
          return { path, resolved: candidate, isFile: s.isFile() };
        } catch {
          // try the next base dir
        }
      }
      return { path, resolved: null, isFile: false };
    }),
  );
}
