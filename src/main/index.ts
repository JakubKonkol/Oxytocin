import { homedir, release } from 'node:os';
import { readFile, realpath, stat } from 'node:fs/promises';
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
import { PLUGIN_SCHEME, registerAppProtocol, registerPrivilegedSchemes } from './app/protocols';
import { createPluginProtocolHandler } from './app/plugin-protocol';
import { installPermissionHandlers, isSafeExternalUrl } from './app/security';
import { resolveUserDataOverride } from './app/user-data';
import { createMainWindow, isTrustedShellUrl } from './app/window-manager';
import { busyTerminals, describeQuit } from './app/quit-guard';
import { Hosts } from './hosts/hosts';
import { registerInvokeHandlers, sendEvent } from './ipc/router';
import { QuickPickBroker } from './services/ui/quick-pick-broker';
import { KeybindingsService } from './services/settings/keybindings-service';
import { PtyPortLink } from './services/terminals/pty-port-link';
import { createLogger, initLogging, logFilePath, setLogLevel } from './logging/log';
import { SettingsService } from './services/settings/settings-service';
import { resolveWindowBounds, UiStateService } from './services/ui-state/ui-state-service';
import { resolveShellEnv } from './services/shell-env/resolve-shell-env';
import { ProfileService } from './services/terminals/profiles';
import { nodeDetectDeps, which } from './services/terminals/shell-detect/deps';
import { spawn as spawnProcess } from 'node:child_process';
import { TerminalService } from './services/terminals/terminal-service';
import type { EnvLayer } from './services/terminals/env-composer';
import { AgentService } from './services/agents/agent-service';
import { ActivityService } from './services/activity/activity-service';
import { GitService } from './services/git/git-service';
import { PluginService } from './services/plugins/plugin-service';
import { verifyPluginChecksums } from './services/plugins/checksums';
import { DevPluginWatcher } from './services/plugins/dev-watcher';
import { type EnvContribution, PluginHostService } from './services/plugins/plugin-host-service';
import { affectedBy, pluginEnvLayers } from './services/plugins/plugin-env';
import { compilePluginAgentRules, pluginTerminalProfiles } from './services/plugins/contributions';
import { DEFAULT_AGENT_RULES } from './services/agents/rules';
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

/** The Oxytocin version (packaged: from the app; dev/E2E: injected at build time). */
const appVersion = app.isPackaged ? app.getVersion() : __OXYTOCIN_VERSION__;

function bootstrap(): void {
  initLogging();
  const log = createLogger('main');
  log.info(`Oxytocin ${appVersion} starting (Electron ${process.versions.electron}, ${process.platform})`);

  const settings = new SettingsService(
    join(app.getPath('userData'), 'settings.json'),
    process.platform as Platform,
    createLogger('settings'),
  );
  setLogLevel(settings.loadSync()['diagnostics.logLevel']);
  settings.watch();
  const keybindings = new KeybindingsService(
    join(app.getPath('userData'), 'keybindings.json'),
    createLogger('keybindings'),
  );
  const keybindingsReady = keybindings.load().then(() => keybindings.watch());

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
    Date.now,
    // Plugins are discovered later in bootstrap; profiles are only listed afterwards.
    () => pluginTerminalProfiles(plugins.contributions()),
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

  const terminals: TerminalService = new TerminalService({
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
    pluginEnv: (ctx): EnvLayer[] => pluginEnvLayers([...pluginHost.environments.values()], ctx, process.platform),
    beforeSpawn: (): Promise<void> => pluginHost.envBarrier(),
    appVersion,
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
  // Performance budget (docs/plan/10-quality-testing-release.md §5): process start → first terminal output.
  let firstTerminalOutputMs: number | null = null;
  const firstOutput = hosts.pty.onEvent('terminal:activity', () => {
    if (firstTerminalOutputMs !== null) return;
    firstTerminalOutputMs = Math.round(performance.now());
    log.info(`Start → first terminal output: ${firstTerminalOutputMs} ms`);
    firstOutput.dispose();
  });
  const agents = new AgentService({
    ptyHost: hosts.pty,
    terminals,
    rules: () => [...DEFAULT_AGENT_RULES, ...compilePluginAgentRules(plugins.contributions())],
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

  const plugins = new PluginService({
    builtinDir: appPaths.builtinPluginsDir(),
    userDir: join(app.getPath('userData'), 'plugins'),
    settings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
    logger: createLogger('plugins'),
    ...(app.isPackaged ? { verifyBuiltin: verifyPluginChecksums } : {}),
  });
  const pluginsReady = plugins.scan().catch((e: unknown) => log.error('Plugin discovery failed', e));
  // Dev paths need a rescan; `plugins.enabled` only changes states.
  let pluginScanKey = JSON.stringify([settings.get()['plugins.developerMode'], settings.get()['plugins.devPaths']]);
  let pluginEnabledKey = JSON.stringify(settings.get()['plugins.enabled']);
  settings.onDidChange((s) => {
    const scanKey = JSON.stringify([s['plugins.developerMode'], s['plugins.devPaths']]);
    const enabledKey = JSON.stringify(s['plugins.enabled']);
    if (scanKey !== pluginScanKey) {
      pluginScanKey = scanKey;
      pluginEnabledKey = enabledKey;
      void plugins.scan();
    } else if (enabledKey !== pluginEnabledKey) {
      pluginEnabledKey = enabledKey;
      plugins.recompute();
    }
  });

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

  // Created with the window below; tracks whether the shell document (main frame) has loaded.
  let ptyPortLink: PtyPortLink | null = null;
  const quickPicks = new QuickPickBroker((request) => {
    if (!mainWindow || mainWindow.isDestroyed() || !ptyPortLink?.loaded) return false;
    sendEvent(mainWindow.webContents, 'ui:quickPick', request);
    return true;
  });

  const pluginHost: PluginHostService = new PluginHostService({
    host: hosts.plugin,
    plugins,
    env: {
      appVersion,
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      locale: app.getLocale() || 'en-US',
      homeDir: homedir(),
      userDataDir: app.getPath('userData'),
    },
    core: {
      projects: {
        list: () => projects.list(),
        get: (id) => projects.get(id),
        activeId: () => projects.activeProjectId,
        findByPath: (path) => projects.findByPath(path),
      },
      terminals: {
        list: (projectId) => terminals.list(projectId),
        get: (id) => terminals.get(id),
        create: (req) => terminals.create(req),
        write: (id, data) => hosts.pty.call('write', { id, data }),
      },
      agents: { list: () => agents.list(), reportSession: (id, sessionId) => agents.reportSession(id, sessionId) },
      git: { status: (id) => git.status(id) },
      settings: () => settings.get(),
      updateSettings: (patch) => settings.update(patch),
      openExternal: (url) => shell.openExternal(url),
      openInEditor: (req) => editor.open(req),
      quickPick: (items, options) => quickPicks.show(items, options),
      toRenderer: (event, payload) => {
        const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
        if (!wc) return;
        if (event === 'toast') sendEvent(wc, 'notifications:show', payload as never);
        else if (event === 'openTerminalPanel') sendEvent(wc, 'terminals:openPanel', payload as never);
        else if (event === 'viewMessage') sendEvent(wc, 'plugins:viewMessage', payload as never);
        else if (event === 'viewMeta') sendEvent(wc, 'plugins:viewMeta', payload as never);
        else if (event === 'openPanel') sendEvent(wc, 'plugins:openPanel', payload as never);
        else if (event === 'pluginReloaded') sendEvent(wc, 'plugins:reloaded', payload as never);
        else sendEvent(wc, 'commands:run', payload as never);
      },
      osNotify: (title, body) => {
        if (e2e) {
          osNotifications.push({ title, body, click: () => undefined });
          return;
        }
        if (Notification.isSupported()) new Notification({ title, body, icon: appPaths.windowIcon() }).show();
      },
    },
    logger: createLogger('plugins'),
  });
  void pluginsReady.then(() => pluginHost.reload());
  const reloadPlugin = async (id: string) => {
    await plugins.scan();
    await pluginHost.reloadPlugin(id);
  };
  // Developer mode: plugins from `plugins.devPaths` reload when their files change.
  const devPluginWatcher = new DevPluginWatcher((id) => void reloadPlugin(id), createLogger('plugins'));
  plugins.onDidChange((list) => devPluginWatcher.update(list, settings.get()['plugins.developerMode']));
  // Environment contributions changed: running terminals in scope are out of date (⟳).
  let previousEnv = new Map<string, EnvContribution>();
  pluginHost.onDidChangeEnvironment((list) => {
    const next = new Map(list.map((c) => [c.pluginId, c]));
    const changed = [...new Set([...previousEnv.keys(), ...next.keys()])].filter(
      (id) => JSON.stringify(previousEnv.get(id)) !== JSON.stringify(next.get(id)),
    );
    for (const t of terminals.list()) {
      if (changed.some((id) => affectedBy(previousEnv.get(id), next.get(id), t))) terminals.markEnvStale(t.id);
    }
    previousEnv = next;
  });
  projects.onDidChange((list) => pluginHost.notifyProjects(list));
  projects.onDidChangeActive((id) => pluginHost.notifyActiveProject(id));
  terminals.onDidUpdate((info) => pluginHost.notifyTerminal(info));
  terminals.onDidRemove((id) => pluginHost.notifyTerminalRemoved(id));
  agents.onDidUpdate((list) => pluginHost.notifyAgents(list));
  git.onDidChangeStatus((status) => pluginHost.notifyGitStatus(status));
  settings.onDidChange((s) => pluginHost.notifySettings(s));

  installPermissionHandlers(session.defaultSession);
  registerAppProtocol(session.defaultSession);
  session.defaultSession.protocol.handle(
    PLUGIN_SCHEME,
    createPluginProtocolHandler({
      pluginRoot: (id) => {
        const p = plugins.get(id);
        return p && (p.state === 'enabled' || p.state === 'active') ? p.path : null;
      },
      dev: !app.isPackaged,
    }),
  );

  registerInvokeHandlers(
    ipcMain,
    {
      'app:readLegal': async ({ doc }) => ({
        text: await readFile(appPaths.legalFile(doc === 'license' ? 'LICENSE' : 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      }),
      'app:getInfo': () => ({
        name: app.getName(),
        version: appVersion,
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
      'ui:quickPickResult': ({ requestId, index }) => quickPicks.settle(requestId, index),
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
      'plugins:list': async () => {
        await pluginsReady;
        return plugins.list();
      },
      'plugins:contributions': async () => {
        await pluginsReady;
        return plugins.contributions();
      },
      'plugins:setEnabled': ({ id, enabled }) => plugins.setEnabled(id, enabled),
      'plugins:reload': ({ id }) => reloadPlugin(id),
      'plugins:loadFromFolder': async () => {
        const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyPickFolderAnswer'] : undefined;
        let dir: string | null;
        if (typeof scripted === 'string' || scripted === null) dir = scripted;
        else {
          const result = await dialog.showOpenDialog(win, {
            title: 'Load plugin from folder',
            properties: ['openDirectory'],
          });
          dir = result.canceled ? null : (result.filePaths[0] ?? null);
        }
        if (!dir) return null;
        const current = settings.get()['plugins.devPaths'];
        await settings.update({
          'plugins.developerMode': true,
          'plugins.devPaths': current.includes(dir) ? current : [...current, dir],
        });
        const found = (await plugins.scan()).find((p) => p.path === dir);
        if (!found)
          return { path: dir, errors: ['No Oxytocin plugin here (a package.json with an "oxytocin" section).'] };
        return { path: dir, id: found.id, errors: found.errors ?? [] };
      },
      'plugins:removeDevPath': async ({ path }) => {
        const current = settings.get()['plugins.devPaths'];
        await settings.update({ 'plugins.devPaths': current.filter((p) => p !== path) });
      },
      'plugins:openDevTools': () => win.webContents.openDevTools({ mode: 'detach' }),
      'plugins:executeCommand': ({ id, args }) => pluginHost.executeCommand(id, args ?? []),
      'plugins:logs': ({ id }) => pluginHost.logs(id),
      'plugins:activate': ({ event }) => pluginHost.activateByEvent(event),
      'plugins:viewOpened': (req) => pluginHost.viewOpened(req),
      'plugins:statusBar': () => [...pluginHost.statusBarItems.values()],
      'plugins:viewClosed': ({ viewId }) => pluginHost.viewClosed(viewId),
      'plugins:viewVisibility': ({ viewId, visible }) => pluginHost.viewVisibility(viewId, visible),
      'plugins:viewMessage': ({ viewId, envelope }) => pluginHost.viewMessage(viewId, envelope),
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
      'settings:problems': () => [...settings.problems],
      'settings:openFile': async () => {
        await editor.open({ path: await settings.ensureFile() });
      },
      'keybindings:get': async () => {
        await keybindingsReady;
        return keybindings.state;
      },
      'keybindings:setForCommand': ({ command, entries }) => keybindings.setForCommand(command, entries),
      'keybindings:openFile': async () => {
        await editor.open({ path: await keybindings.ensureFile() });
      },
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
  keybindings.onDidChange((state) => sendEvent(win.webContents, 'keybindings:changed', state));
  hosts.onDidChangeStatus((status) => sendEvent(win.webContents, 'hosts:status', status));
  terminals.onDidUpdate((info) => sendEvent(win.webContents, 'terminals:updated', info));
  agents.onDidUpdate((list) => sendEvent(win.webContents, 'agents:updated', list));
  activity.onDidChange((list) => sendEvent(win.webContents, 'projects:activity', list));
  git.onDidChangeStatus((status) => sendEvent(win.webContents, 'git:status', status));
  pluginHost.onDidChangeStatusBar((items) => sendEvent(win.webContents, 'plugins:statusBar', items));
  let lastContributions = '';
  plugins.onDidChange((list) => {
    sendEvent(win.webContents, 'plugins:changed', list);
    const contributions = plugins.contributions();
    const key = JSON.stringify(contributions);
    if (key !== lastContributions) {
      lastContributions = key;
      sendEvent(win.webContents, 'plugins:contributionsChanged', contributions);
    }
  });
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
  const link = new PtyPortLink(
    () => hosts.pty.state === 'running',
    () => {
      if (win.isDestroyed()) return;
      const { port1, port2 } = new MessageChannelMain();
      hosts.pty.emit('renderer-port', { windowId: win.id }, [port1]);
      win.webContents.postMessage('pty:port', null, [port2]);
    },
  );
  ptyPortLink = link;
  win.webContents.on('did-finish-load', () => link.shellDidLoad());
  // A reload or crash drops the palette: pending plugin quick picks resolve as dismissed.
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    link.shellDidUnload();
    quickPicks.cancelAll();
  });
  win.webContents.on('render-process-gone', () => {
    link.shellDidUnload();
    quickPicks.cancelAll();
  });
  win.on('closed', () => quickPicks.cancelAll());
  hosts.pty.onDidBecomeReady(() => link.hostDidBecomeReady());

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
      plugins,
      pluginHost,
      osNotifications,
      attentionCount: () => attentionCount,
      lastQuitPrompt: () => lastQuitPrompt,
      editor,
      workspaceState,
      projects,
      logFile: () => logFilePath(),
      perf: () => ({ firstTerminalOutputMs }),
    };
  }
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => app.quit());
