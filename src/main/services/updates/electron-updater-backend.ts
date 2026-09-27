import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type * as ElectronUpdater from 'electron-updater';
import type { Logger } from '@shared/logging/logger';
import type { UpdaterBackend } from './update-service';

export interface UpdateSupportInput {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  resourcesPath: string;
}

/** Why automatic updates are unavailable in this build, or null when they are supported. */
export async function updateUnsupportedReason(input: UpdateSupportInput): Promise<string | null> {
  if (!input.isPackaged) return 'Updates are turned off in development builds.';
  if (input.platform === 'linux' && !input.env['APPIMAGE'])
    return 'Automatic updates are available for the AppImage only. Update this package with your package manager.';
  try {
    await access(join(input.resourcesPath, 'app-update.yml'));
  } catch {
    return 'This build has no update configuration.';
  }
  return null;
}

/** electron-updater (GitHub Releases provider, configured by electron-builder's `publish` section). */
export async function createElectronUpdaterBackend(logger: Logger): Promise<UpdaterBackend> {
  // A CommonJS module: its `autoUpdater` getter is only reachable through the default export.
  const mod = (await import('electron-updater')) as typeof ElectronUpdater & { default?: typeof ElectronUpdater };
  const { autoUpdater } = mod.default ?? mod;
  autoUpdater.autoDownload = false;
  // Oxytocin installs in its own quit sequence (after QuitGuard). Squirrel.Mac always applies a downloaded
  // update when the app exits, so the flag only matters on Windows and Linux.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m?: unknown) => logger.info(String(m)),
    warn: (m?: unknown) => logger.warn(String(m)),
    error: (m?: unknown) => logger.error(String(m)),
    debug: (m: string) => logger.debug(m),
  };
  return {
    setChannel(channel) {
      // GitHub Releases: the beta channel means "also pre-releases" (their beta*.yml, else latest*.yml).
      autoUpdater.allowPrerelease = channel === 'beta';
      // Switching back to "latest" from a beta version must not install an older stable version.
      autoUpdater.allowDowngrade = false;
    },
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null;
    },
    async download(onProgress) {
      const progress = (p: { percent: number }) => onProgress(p.percent);
      let downloaded!: () => void;
      const done = new Promise<void>((resolve) => (downloaded = resolve));
      autoUpdater.on('download-progress', progress);
      autoUpdater.once('update-downloaded', downloaded);
      try {
        await autoUpdater.downloadUpdate();
        // macOS: the file is handed to Squirrel.Mac first; the update is ready once it reports back.
        await done;
      } finally {
        autoUpdater.off('download-progress', progress);
        autoUpdater.off('update-downloaded', downloaded);
      }
    },
    install(restart) {
      // Squirrel.Mac installs on exit by itself; quitAndInstall there always relaunches.
      if (process.platform === 'darwin' && !restart) return false;
      autoUpdater.quitAndInstall(true, restart);
      return true;
    },
  };
}
