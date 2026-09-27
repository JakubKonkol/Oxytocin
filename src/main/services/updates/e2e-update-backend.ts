import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdaterBackend } from './update-service';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted update backend for E2E runs (OXYTOCIN_E2E=1 only). Tests set `globalThis.__oxyFakeUpdate` in main to
 * `{ version }` (an update), `{ error }` (a failing check) or null (up to date); installing writes
 * `e2e-update-installed.json` into userData because the app exits right after.
 */
export function createE2eUpdateBackend(userDataDir: string): UpdaterBackend {
  const g = globalThis as Record<string, unknown>;
  return {
    setChannel(channel) {
      g['__oxyUpdateChannel'] = channel;
    },
    async check() {
      await delay(50);
      const next = g['__oxyFakeUpdate'] as { version?: string; error?: string } | null | undefined;
      if (next?.error) throw new Error(next.error);
      return next?.version ? { version: next.version } : null;
    },
    async download(onProgress) {
      for (const percent of [5, 30, 65, 100]) {
        await delay(150);
        onProgress(percent);
      }
    },
    install(restart) {
      // Test-only: the process exits immediately after this call.
      writeFileSync(join(userDataDir, 'e2e-update-installed.json'), JSON.stringify({ restart }));
      return false;
    },
  };
}
