import { join } from 'node:path';
import { app, type BrowserWindow, ipcMain, screen, session } from 'electron';
import type { Platform } from '@shared/domain/terminal-profile';
import { registerAppProtocol, registerPrivilegedSchemes } from './app/protocols';
import { installPermissionHandlers } from './app/security';
import { resolveUserDataOverride } from './app/user-data';
import { createMainWindow, isTrustedShellUrl } from './app/window-manager';
import { Hosts } from './hosts/hosts';
import { registerInvokeHandlers, sendEvent } from './ipc/router';
import { createLogger, initLogging, logFilePath, setLogLevel } from './logging/log';
import { SettingsService } from './services/settings/settings-service';
import { resolveWindowBounds, UiStateService } from './services/ui-state/ui-state-service';

const e2e = process.env['OXYTOCIN_E2E'] === '1';

const userDataOverride = resolveUserDataOverride(process.argv, process.env);
if (userDataOverride) app.setPath('userData', userDataOverride);

// The single-instance lock is scoped to the userData directory, so isolated profiles can run side by side.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

registerPrivilegedSchemes();

let mainWindow: BrowserWindow | null = null;

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function bootstrap(): void {
  initLogging();
  const log = createLogger('main');
  log.info(`Oxytocin ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform})`);

  const settings = new SettingsService(
    join(app.getPath('userData'), 'settings.json'),
    process.platform as Platform,
    createLogger('settings'),
  );
  setLogLevel(settings.loadSync()['diagnostics.logLevel']);
  settings.watch();

  const uiState = new UiStateService(join(app.getPath('userData'), 'ui-state.json'), createLogger('ui-state'));
  const initialUi = uiState.loadSync();

  const hosts = new Hosts(createLogger, () => ({ ...process.env }));
  hosts.startAll();

  installPermissionHandlers(session.defaultSession);
  registerAppProtocol(session.defaultSession);

  registerInvokeHandlers(
    ipcMain,
    {
      'app:getInfo': () => ({
        name: app.getName(),
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          v8: process.versions.v8,
        },
        userDataDir: app.getPath('userData'),
        e2e,
      }),
      'app:getHostStatus': () => hosts.status(),
      'settings:get': () => settings.get(),
      'ui:getState': () => uiState.get(),
      'ui:patchState': (patch) => uiState.patch(patch),
    },
    { isTrustedUrl: isTrustedShellUrl, logger: createLogger('ipc') },
  );

  mainWindow = createMainWindow({
    bounds: resolveWindowBounds(initialUi.window, screen.getAllDisplays(), screen.getPrimaryDisplay()),
    maximized: initialUi.window.maximized,
  });
  const win = mainWindow;
  uiState.trackWindow(win, () => screen.getDisplayMatching(win.getBounds()).id);
  win.on('closed', () => (mainWindow = null));
  settings.onDidChange((s) => {
    setLogLevel(s['diagnostics.logLevel']);
    sendEvent(win.webContents, 'settings:changed', s);
  });
  hosts.onDidChangeStatus((status) => sendEvent(win.webContents, 'hosts:status', status));

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    Promise.all([uiState.flush(), hosts.stopAll()])
      .catch((e: unknown) => log.error('Failed to stop hosts', e))
      .finally(() => {
        settings.dispose();
        app.exit(0);
      });
  });

  if (e2e) {
    // Test-only hooks, reachable via electronApp.evaluate(); never installed without OXYTOCIN_E2E=1.
    (globalThis as Record<string, unknown>)['__oxyMain'] = {
      hosts,
      logFile: () => logFilePath(),
    };
  }
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => app.quit());
