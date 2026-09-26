import { homedir, release } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
} from 'electron';
import { DEFAULT_PROJECT_ID } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { Platform } from '@shared/domain/terminal-profile';
import { appPaths } from './app/paths';
import { registerAppProtocol, registerPrivilegedSchemes } from './app/protocols';
import { installPermissionHandlers, isSafeExternalUrl } from './app/security';
import { resolveUserDataOverride } from './app/user-data';
import { createMainWindow, isTrustedShellUrl } from './app/window-manager';
import { busyTerminals, describeQuit } from './app/quit-guard';
import { Hosts } from './hosts/hosts';
import { registerInvokeHandlers, sendEvent } from './ipc/router';
import { createLogger, initLogging, logFilePath, setLogLevel } from './logging/log';
import { SettingsService } from './services/settings/settings-service';
import { resolveWindowBounds, UiStateService } from './services/ui-state/ui-state-service';
import { resolveShellEnv } from './services/shell-env/resolve-shell-env';
import { ProfileService } from './services/terminals/profiles';
import { nodeDetectDeps, which } from './services/terminals/shell-detect/deps';
import { spawn as spawnProcess } from 'node:child_process';
import { TerminalService } from './services/terminals/terminal-service';
import { AgentService } from './services/agents/agent-service';
import { ActivityService } from './services/activity/activity-service';
import { GitService } from './services/git/git-service';
import { NotificationService } from './services/notifications/notification-service';
import { ClaudeRegistry, claudeAgentsCli } from './services/agents/claude-registry';
import { statMany } from './services/fs/stat-many';
import { EditorLauncher } from './services/editor/editor-launcher';
import { ProjectService } from './services/projects/project-service';
import { projectPathsFromArgv } from './app/argv';
import { restoredScrollbackData, WorkspaceStateService } from './services/workspace-state/workspace-state-service';

const e2e = process.env['OXYTOCIN_E2E'] === '1';

const userDataOverride = resolveUserDataOverride(process.argv, process.env);
if (userDataOverride) app.setPath('userData', userDataOverride);

// The single-instance lock is scoped to the userData directory, so isolated profiles can run side by side.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

registerPrivilegedSchemes();

let mainWindow: BrowserWindow | null = null;

// Folders passed to a second instance (or found in argv before the app is ready) are added as projects.
let pendingSecondInstance: { argv: string[]; cwd: string }[] = [];
let handleSecondInstance: ((argv: string[], cwd: string) => void) | null = null;
app.on('second-instance', (_event, argv, workingDirectory) => {
  if (handleSecondInstance) handleSecondInstance(argv, workingDirectory);
  else pendingSecondInstance.push({ argv, cwd: workingDirectory });
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
  const projects = new ProjectService({
    file: join(app.getPath('userData'), 'projects.json'),
    fs: {
      realpath: (p) => realpath(p),
      isDirectory: async (p) => {
        try {
          return (await stat(p)).isDirectory();
        } catch {
          return false;
        }
      },
    },
    platform: process.platform,
    homeDir: homedir(),
    ...(process.env['SystemRoot'] ? { systemRoot: process.env['SystemRoot'] } : {}),
    logger: createLogger('projects'),
  });
  const projectsReady = projects.load();

  const workspaceState = new WorkspaceStateService(
    join(app.getPath('userData'), 'workspaces'),
    createLogger('workspace'),
  );

  const terminals = new TerminalService({
    ptyHost: hosts.pty,
    profiles,
    settings: () => settings.get(),
    resolveProject: (projectId) => {
      const project = projects.get(projectId);
      if (project)
        return project.settings.env
          ? { rootPath: project.rootPath, env: project.settings.env }
          : { rootPath: project.rootPath };
      // Pseudo-project used before any project is added (the default workspace).
      return projectId === DEFAULT_PROJECT_ID ? { rootPath: homedir() } : null;
    },
    baseEnv: () => shellEnvReady,
    readScrollback: async (projectId, panelId) => {
      if (!settings.get()['terminal.restoreScrollback']) return null;
      const saved = await workspaceState.readScrollback(projectId, panelId);
      return saved ? restoredScrollbackData(saved.data, saved.savedAt) : null;
    },
    appVersion: app.getVersion(),
    dev: !app.isPackaged,
    platform: process.platform,
    logger: createLogger('terminals'),
  });

  // Claude Code session registry (docs/plan/04-terminals.md §9.3); CLAUDE_CONFIG_DIR may come from the login shell.
  const claudeRegistry = new ClaudeRegistry({
    dir: join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'sessions'),
    logger: createLogger('agents'),
    cliFallback: claudeAgentsCli(),
  });
  const agents = new AgentService({
    ptyHost: hosts.pty,
    terminals,
    registry: claudeRegistry,
    logger: createLogger('agents'),
  });
  void shellEnvReady.then((env) => {
    const configDir = env['CLAUDE_CONFIG_DIR'];
    if (configDir && configDir !== process.env['CLAUDE_CONFIG_DIR']) claudeRegistry.setDir(join(configDir, 'sessions'));
    claudeRegistry.start();
  });

  const activity = new ActivityService(terminals, () => projects.list().map((p) => p.id));
  const osNotifications: { title: string; body: string; click: () => void }[] = [];
  let attentionCount = 0;
  const applyAttention = ({ count, overlay }: { count: number; overlay?: string | undefined }) => {
    attentionCount = count;
    if (process.platform === 'win32') {
      mainWindow?.setOverlayIcon(
        count > 0 && overlay ? nativeImage.createFromDataURL(overlay) : null,
        count > 0 ? `${count} waiting` : '',
      );
    } else if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else {
      app.setBadgeCount(count);
    }
  };

  const git = new GitService({
    host: hosts.workspace,
    projects: {
      list: () => projects.list(),
      activeId: () => projects.activeProjectId,
      onDidChange: projects.onDidChange,
      onDidChangeActive: projects.onDidChangeActive,
    },
    settings: () => settings.get(),
    onDidChangeSettings: settings.onDidChange,
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    logger: createLogger('git'),
  });
  void projectsReady.then(() => git.start());

  const detectDeps = nodeDetectDeps(() => shellEnv);
  const editor = new EditorLauncher({
    settings: () => settings.get(),
    projectFor: (path) => {
      const p = projects.findByPath(path);
      return p
        ? {
            id: p.id,
            rootPath: p.rootPath,
            ...(p.settings.editorCommand ? { editorCommand: p.settings.editorCommand } : {}),
          }
        : undefined;
    },
    which: (name) => which(name, detectDeps),
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    spawn: (file, args, { verbatim }) => {
      const child = spawnProcess(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: verbatim,
        env: shellEnv,
      });
      child.on('error', (e) => log.warn(`Editor launch failed: ${e.message}`));
      child.unref();
    },
    openPath: (path) => shell.openPath(path),
    openInTerminal: (req) => {
      if (mainWindow && !mainWindow.isDestroyed()) sendEvent(mainWindow.webContents, 'editor:openInTerminal', req);
    },
    platform: process.platform,
    logger: createLogger('editor'),
    dryRun: e2e,
  });

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
      'settings:update': (patch) => settings.update(patch),
      'projects:list': async () => {
        await projectsReady;
        return projects.list();
      },
      'projects:getActive': async () => {
        await projectsReady;
        return { id: projects.activeProjectId };
      },
      'projects:add': ({ path }) => projects.add(path),
      'projects:remove': async ({ id, killTerminals }) => {
        if (killTerminals) await Promise.all(terminals.list(id).map((t) => terminals.close(t.id)));
        projects.remove(id);
        await workspaceState.delete(id);
      },
      'projects:update': (patch) => projects.update(patch),
      'projects:reorder': ({ ids }) => projects.reorder(ids),
      'projects:setActive': ({ id }) => projects.setActive(id),
      'projects:pickFolder': async () => {
        const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyPickFolderAnswer'] : undefined;
        if (typeof scripted === 'string' || scripted === null) return scripted;
        const result = await dialog.showOpenDialog(win, {
          title: 'Add project',
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      'workspace:load': ({ projectId }) => workspaceState.load(projectId),
      'workspace:save': (state) => workspaceState.save(state),
      'ui:getState': () => uiState.get(),
      'ui:patchState': (patch) => uiState.patch(patch),
      'terminals:create': (req) => terminals.create(req),
      'terminals:kill': (req) => terminals.kill(req.id, req.force ?? false),
      'terminals:restart': (req) => terminals.restart(req.id),
      'terminals:rename': (req) => terminals.rename(req.id, req.title),
      'terminals:dispose': (req) => terminals.close(req.id),
      'terminals:list': (req) => terminals.list(req?.projectId),
      'terminals:profiles': () => profiles.list(),
      'agents:list': () => agents.list(),
      'projects:getActivity': () => activity.list(),
      'git:getStatus': ({ projectId }) => git.status(projectId),
      'git:refresh': ({ projectId }) => git.refresh(projectId, 'manual'),
      'git:getFileDiff': (req) => git.fileDiff(req),
      'terminals:markSeen': ({ id }) => activity.markSeen(id),
      'window:setAttention': (req) => applyAttention(req),
      // The renderer has no clipboard-read permission; main reads it on request (Ctrl+V).
      'clipboard:read': async () => {
        const text = await clipboard.readText();
        return { text, hasImage: text === '' && (await clipboard.has('image/png')) };
      },
      'clipboard:writeText': ({ text }) => clipboard.writeText(text),
      'terminals:clearBell': ({ id }) => terminals.clearBell(id),
      'fs:statMany': ({ baseDirs, paths }) => statMany(baseDirs, paths),
      'editor:open': (req) => editor.open(req),
      'shell:revealInFolder': ({ path }) => {
        if (e2e) return;
        shell.showItemInFolder(path);
      },
      'shell:openExternal': async ({ url }) => {
        if (!isSafeExternalUrl(url))
          throw new OxyError('PERMISSION', 'Only http, https and mailto links can be opened');
        await shell.openExternal(url);
      },
    },
    { isTrustedUrl: isTrustedShellUrl, logger: createLogger('ipc') },
  );

  // Dev runs use the generic Electron dock icon on macOS; packaged builds use the bundle icon.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(appPaths.windowIcon());

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
  agents.onDidUpdate((list) => sendEvent(win.webContents, 'agents:updated', list));
  activity.onDidChange((list) => sendEvent(win.webContents, 'projects:activity', list));
  git.onDidChangeStatus((status) => sendEvent(win.webContents, 'git:status', status));
  git.onDidTouchFiles((e) => sendEvent(win.webContents, 'git:fileTouched', e));

  // Attention system (docs/plan/02-ui-ux.md §9).
  const liveNotifications = new Set<Notification>();
  const reveal = (target: { projectId: string; terminalId: string }) => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    void projects
      .setActive(target.projectId)
      .catch(() => undefined)
      .then(() => sendEvent(win.webContents, 'terminals:reveal', target));
  };
  const notifications = new NotificationService({
    terminals,
    settings: () => settings.get(),
    projectName: (id) => projects.get(id)?.name,
    toast: (payload) => sendEvent(win.webContents, 'notifications:show', payload),
    window: {
      isFocused: () => {
        const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyWindowFocused'] : undefined;
        return typeof scripted === 'boolean' ? scripted : win.isFocused();
      },
      flash: (on) => {
        if (!win.isDestroyed()) win.flashFrame(on);
      },
    },
    osNotify: ({ title, body, onClick }) => {
      if (e2e) {
        osNotifications.push({ title, body, click: onClick });
        return;
      }
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, icon: appPaths.windowIcon() });
      liveNotifications.add(n);
      n.on('click', () => {
        liveNotifications.delete(n);
        onClick();
      });
      n.on('close', () => liveNotifications.delete(n));
      n.show();
    },
    reveal,
  });
  win.on('focus', () => {
    notifications.onWindowFocus();
    git.onWindowFocus();
  });
  projects.onDidChange((list) => sendEvent(win.webContents, 'projects:changed', list));
  projects.onDidChangeActive((id) => sendEvent(win.webContents, 'projects:active', { id }));

  const addFromArgv = async (argv: readonly string[], cwd: string) => {
    await projectsReady;
    for (const path of projectPathsFromArgv(argv, { isPackaged: app.isPackaged, cwd })) {
      try {
        const result = await projects.add(path);
        if (result.warning) sendEvent(win.webContents, 'notifications:show', { kind: 'info', message: result.warning });
      } catch (e) {
        log.warn(`Could not add ${path} from the command line`, e);
        sendEvent(win.webContents, 'notifications:show', {
          kind: 'error',
          message: `Could not add ${path}`,
          description: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  handleSecondInstance = (argv, cwd) => {
    if (win.isMinimized()) win.restore();
    win.focus();
    void addFromArgv(argv, cwd);
  };
  for (const pending of pendingSecondInstance) handleSecondInstance(pending.argv, pending.cwd);
  pendingSecondInstance = [];
  void addFromArgv(process.argv, process.cwd());
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

  // Quit sequence (docs/plan/01-architecture.md §7): QuitGuard → flush layouts → scrollback snapshots → hosts.
  let quitting = false;
  let lastQuitPrompt: { message: string; detail: string } | null = null;
  let quitInProgress = false;
  const quitGuard = async (): Promise<boolean> => {
    if (!settings.get()['terminal.confirmOnQuit']) return true;
    const busy = busyTerminals(terminals.list());
    if (busy.length === 0) return true;
    const { message, detail } = describeQuit(busy, (id) => projects.get(id)?.name);
    if (e2e) {
      lastQuitPrompt = { message, detail };
      // Tests answer through a global; a native dialog would block Playwright's app.close().
      return (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] !== 'cancel';
    }
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'warning',
      message,
      detail,
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: "Don't ask again",
    });
    if (response !== 0) return false;
    if (checkboxChecked) await settings.update({ 'terminal.confirmOnQuit': false });
    return true;
  };
  const withTimeout = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    void (async () => {
      try {
        if (!(await quitGuard())) return;
        quitting = true;
        if (!win.isDestroyed()) {
          await withTimeout(
            win.webContents.executeJavaScript(
              'window.__oxyFlushWorkspaces ? window.__oxyFlushWorkspaces() : null',
              true,
            ),
            2000,
          ).catch(() => undefined);
        }
        await workspaceState.flush();
        const s = settings.get();
        if (s['terminal.restoreScrollback']) {
          await withTimeout(
            workspaceState.persistScrollback(async (terminalId) => {
              const info = terminals.get(terminalId);
              if (!info || info.state !== 'running') return null;
              const snap = await hosts.pty.call('serialize', {
                id: terminalId,
                scrollback: s['terminal.persistScrollbackLines'],
              });
              return snap.data;
            }),
            3000,
          ).catch((e: unknown) => log.warn('Failed to persist scrollback', e));
        }
        await Promise.all([uiState.flush(), projects.flush(), hosts.stopAll()]);
      } catch (e) {
        log.error('Error during quit', e);
      } finally {
        quitInProgress = false;
        if (quitting) {
          settings.dispose();
          app.exit(0);
        }
      }
    })();
  });

  if (e2e) {
    // Test-only hooks, reachable via electronApp.evaluate(); never installed without OXYTOCIN_E2E=1.
    (globalThis as Record<string, unknown>)['__oxyMain'] = {
      hosts,
      terminals,
      agents,
      activity,
      git,
      osNotifications,
      attentionCount: () => attentionCount,
      lastQuitPrompt: () => lastQuitPrompt,
      editor,
      workspaceState,
      projects,
      logFile: () => logFilePath(),
    };
  }
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => app.quit());
