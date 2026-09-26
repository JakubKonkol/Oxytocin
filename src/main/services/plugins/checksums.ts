import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CHECKSUM_FILE = 'oxytocin-checksums.json';

/**
 * Verifies the SHA-256 checksums written by `scripts/build-plugins.ts` (packaged built-in plugins).
 * Returns the problems found (empty = intact).
 */
export async function verifyPluginChecksums(pluginDir: string): Promise<string[]> {
  let sums: Record<string, string>;
  try {
    sums = JSON.parse(await readFile(join(pluginDir, CHECKSUM_FILE), 'utf8')) as Record<string, string>;
  } catch {
    return [`${CHECKSUM_FILE} is missing or unreadable`];
  }
  const problems: string[] = [];
  for (const [rel, expected] of Object.entries(sums)) {
    if (rel.split('/').includes('..')) {
      problems.push(`invalid path in ${CHECKSUM_FILE}: ${rel}`);
      continue;
    }
    try {
      const actual = createHash('sha256')
        .update(await readFile(join(pluginDir, ...rel.split('/'))))
        .digest('hex');
      if (actual !== expected) problems.push(`${rel} was modified`);
    } catch {
      problems.push(`${rel} is missing`);
    }
  }
  return problems;
}
