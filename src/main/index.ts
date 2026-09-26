import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { app, type BrowserWindow, clipboard, ipcMain, MessageChannelMain, screen, session, shell } from 'electron';
import { DEFAULT_PROJECT_ID } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { Platform } from '@shared/domain/terminal-profile';
import { registerAppProtocol, registerPrivilegedSchemes } from './app/protocols';
import { installPermissionHandlers, isSafeExternalUrl } from './app/security';
import { resolveUserDataOverride } from './app/user-data';
import { createMainWindow, isTrustedShellUrl } from './app/window-manager';
import { Hosts } from './hosts/hosts';
import { registerInvokeHandlers, sendEvent } from './ipc/router';
import { createLogger, initLogging, logFilePath, setLogLevel } from './logging/log';
import { SettingsService } from './services/settings/settings-service';
import { resolveWindowBounds, UiStateService } from './services/ui-state/ui-state-service';
import { resolveShellEnv } from './services/shell-env/resolve-shell-env';
import { ProfileService } from './services/terminals/profiles';
import { nodeDetectDeps } from './services/terminals/shell-detect/deps';
import { TerminalService } from './services/terminals/terminal-service';
import { statMany } from './services/fs/stat-many';
import { EditorLauncher } from './services/editor/editor-launcher';

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

  let shellEnv: NodeJS.ProcessEnv = process.env;
  const shellEnvReady = resolveShellEnv({
    platform: process.platform,
    env: process.env,
    logger: createLogger('shell-env'),
  }).then((env) => (shellEnv = env));
  const profiles = new ProfileService(
    nodeDetectDeps(() => shellEnv),
    () => settings.get(),
  );
  const terminals = new TerminalService({
    ptyHost: hosts.pty,
    profiles,
    settings: () => settings.get(),
    // Until projects exist (M3), terminals live in a default project rooted at the home directory.
    resolveProject: (projectId) => (projectId === DEFAULT_PROJECT_ID ? { rootPath: homedir() } : null),
    baseEnv: () => shellEnvReady,
    appVersion: app.getVersion(),
    dev: !app.isPackaged,
    platform: process.platform,
    logger: createLogger('terminals'),
  });

  const editor = new EditorLauncher(createLogger('editor'), e2e);

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
        osBuild: process.platform === 'win32' ? Number(release().split('.')[2] ?? 0) : 0,
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
      'terminals:create': (req) => terminals.create(req),
      'terminals:kill': (req) => terminals.kill(req.id, req.force ?? false),
      'terminals:restart': (req) => terminals.restart(req.id),
      'terminals:rename': (req) => terminals.rename(req.id, req.title),
      'terminals:dispose': (req) => terminals.close(req.id),
      'terminals:list': (req) => terminals.list(req?.projectId),
      'terminals:profiles': () => profiles.list(),
      // The renderer has no clipboard-read permission; main reads it on request (Ctrl+V).
      'clipboard:read': async () => {
        const text = await clipboard.readText();
        return { text, hasImage: text === '' && (await clipboard.has('image/png')) };
      },
      'clipboard:writeText': ({ text }) => clipboard.writeText(text),
      'terminals:clearBell': ({ id }) => terminals.clearBell(id),
      'fs:statMany': ({ baseDirs, paths }) => statMany(baseDirs, paths),
      'editor:open': (req) => editor.open(req),
      'shell:openExternal': async ({ url }) => {
        if (!isSafeExternalUrl(url))
          throw new OxyError('PERMISSION', 'Only http, https and mailto links can be opened');
        await shell.openExternal(url);
      },
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
  terminals.onDidUpdate((info) => sendEvent(win.webContents, 'terminals:updated', info));
  terminals.onDidRemove((id) => sendEvent(win.webContents, 'terminals:removed', { id }));

  // Terminal I/O flows renderer ⇄ PTY Host over a direct MessagePort; re-created after renderer reloads
  // and PTY Host restarts (docs/plan/01-architecture.md §4.5).
  const connectPtyPort = () => {
    if (win.isDestroyed() || hosts.pty.state !== 'running') return;
    const { port1, port2 } = new MessageChannelMain();
    hosts.pty.emit('renderer-port', { windowId: win.id }, [port1]);
    win.webContents.postMessage('pty:port', null, [port2]);
  };
  win.webContents.on('did-finish-load', connectPtyPort);
  hosts.pty.onDidBecomeReady(() => {
    if (!win.webContents.isLoading()) connectPtyPort();
  });

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
      terminals,
      editor,
      logFile: () => logFilePath(),
    };
  }
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => app.quit());
