// node-pty's macOS prebuilds ship `spawn-helper` without the executable bit, which makes every spawn fail
// with "posix_spawnp failed". Restore it after install (no-op elsewhere).
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'darwin') {
  const prebuilds = join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
}
