import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdaterBackend } from './update-service';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted update backend for E2E runs (OXYTOCIN_E2E=1 only). Tests set `globalThis.__oxyFakeUpdate` in main to
 * `{ version }` (an update), `{ version, downloadError }` (an update whose download fails), `{ error }` (a failing
 * check) or null (up to date); `__oxyFakeUpdateStepMs` slows the download down. Installing writes
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
      const next = g['__oxyFakeUpdate'] as { downloadError?: string } | null | undefined;
      const step = (g['__oxyFakeUpdateStepMs'] as number | undefined) ?? 150;
      const total = 120 * 1024 * 1024;
      for (const percent of [5, 30, 65, 100]) {
        await delay(step);
        if (next?.downloadError && percent > 30) throw new Error(next.downloadError);
        onProgress({ percent, transferred: (total * percent) / 100, total, bytesPerSecond: 8 * 1024 * 1024 });
      }
    },
    install(restart) {
      // Test-only: the process exits immediately after this call.
      writeFileSync(join(userDataDir, 'e2e-update-installed.json'), JSON.stringify({ restart }));
      return false;
    },
  };
}
