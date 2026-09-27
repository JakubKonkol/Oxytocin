import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateUnsupportedReason } from './electron-updater-backend';

describe('updateUnsupportedReason', () => {
  it('allows updates only in packaged builds with an update configuration', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'oxy-updates-'));
    const input = { isPackaged: true, platform: 'win32' as const, env: {}, resourcesPath };
    expect(await updateUnsupportedReason({ ...input, isPackaged: false })).toMatch(/development builds/);
    expect(await updateUnsupportedReason(input)).toMatch(/no update configuration/);
    await writeFile(join(resourcesPath, 'app-update.yml'), 'provider: github\n');
    expect(await updateUnsupportedReason(input)).toBeNull();
    // Linux: the AppImage updates itself; deb packages are updated by the package manager.
    expect(await updateUnsupportedReason({ ...input, platform: 'linux' })).toMatch(/AppImage only/);
    expect(
      await updateUnsupportedReason({ ...input, platform: 'linux', env: { APPIMAGE: '/opt/Oxytocin.AppImage' } }),
    ).toBeNull();
  });
});
