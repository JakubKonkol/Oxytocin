import { homedir, release } from 'node:os';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { DEFAULT_PROJECT_ID } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { ConfirmRequest } from '@shared/domain/confirm';
import type { Platform } from '@shared/domain/terminal-profile';
import type { NotificationPayload } from '@shared/ipc/events';
import { appPaths } from './app/paths';
import { PLUGIN_SCHEME, registerAppProtocol, registerPrivilegedSchemes } from './app/protocols';
import { createPluginProtocolHandler } from './app/plugin-protocol';
import { hardenNewWebContents, installPermissionHandlers, isSafeExternalUrl } from './app/security';
import { installAppMenu } from './app/app-menu';
import { RendererRecovery } from './app/renderer-recovery';
import { resolveUserDataOverride } from './app/user-data';
import { applyNativeTheme, createMainWindow, isTrustedShellUrl } from './app/window-manager';
import { busyTerminals, describeQuit, type QuitPrompt } from './app/quit-guard';
import { Hosts } from './hosts/hosts';
import { registerInvokeHandlers, sendEvent } from './ipc/router';
import { RendererRequests } from './services/ui/renderer-requests';
import { QuickPickBroker } from './services/ui/quick-pick-broker';
import { KeybindingsService } from './services/settings/keybindings-service';
import { installShellIntegration } from './services/terminals/shell-integration';
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
import { FileService } from './services/files/file-service';
import { PluginService } from './services/plugins/plugin-service';
import { verifyPluginChecksums } from './services/plugins/checksums';
import { DevPluginWatcher } from './services/plugins/dev-watcher';
import {
  type EnvContribution,
  PluginHostService,
  type PluginHostServiceDeps,
} from './services/plugins/plugin-host-service';
import { PluginHosts, runsInBuiltinHost, scopedPlugins } from './services/plugins/plugin-hosts';
import { PluginInstaller } from './services/plugins/plugin-installer';
import { affectedBy, pluginEnvLayers } from './services/plugins/plugin-env';
import { compilePluginAgentRules, pluginTerminalProfiles } from './services/plugins/contributions';
import { DEFAULT_AGENT_RULES } from './services/agents/rules';
import { NotificationService } from './services/notifications/notification-service';
import { ClaudeRegistry, claudeAgentsCli } from './services/agents/claude-registry';
import { statMany } from './services/fs/stat-many';
import { EditorLauncher } from './services/editor/editor-launcher';
import { ProjectService } from './services/projects/project-service';
import { projectPathsFromArgv } from './app/argv';
import { WorkspaceStateService } from './services/workspace-state/workspace-state-service';
import { sessionRestoredLabel } from './services/terminals/scrollback-format';
import { UpdateService, type UpdaterBackend } from './services/updates/update-service';
import { createElectronUpdaterBackend, updateUnsupportedReason } from './services/updates/electron-updater-backend';
import { createE2eUpdateBackend } from './services/updates/e2e-update-backend';
import { McpHub } from './services/mcp/mcp-hub';
import { createCliRunner } from './services/mcp/client-registration';
import type { PluginToolSource } from './services/mcp/tool-registry';
import { JsonFileStore } from './services/storage/json-file-store';
import type { McpToolResult } from '@shared/domain/mcp';
import { SecretStore } from './services/secrets/secret-store';
import { ResourceService } from './services/resources/resource-service';
import { ResourcesController } from './services/resources/resources-controller';
import { EnsembleService } from './services/ensemble/ensemble-service';
import { detectCommand } from './services/ensemble/cli-detect';
import type { EnsembleRecord } from '@shared/domain/ensemble';

const e2e = process.env['OXYTOCIN_E2E'] === '1';
/** The answer of the Usage Monitor's `oxytocin.usage-monitor.totals` command (Ensemble costs). */
const UsageTotalsSchema = z.record(z.string(), z.object({ costUsd: z.number(), tokens: z.number() }));

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
  // Uncaught exceptions and unhandled rejections are logged by initLogging (electron-log, no blocking dialog).
  hardenNewWebContents(app);
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit')
      log.warn(`Child process gone: ${details.type} (${details.reason}, exit code ${details.exitCode})`);
  });

  const settings = new SettingsService(
    join(app.getPath('userData'), 'settings.json'),
    process.platform as Platform,
    createLogger('settings'),
  );
  setLogLevel(settings.loadSync()['diagnostics.logLevel']);
  applyNativeTheme(settings.get()['appearance.theme']);
  settings.onDidChange((s) => applyNativeTheme(s['appearance.theme']));
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
  // Shell/agent detection (PATH lookups, `reg`, `wsl -l`) runs while the window loads, not when the first
  // terminal is requested.
  void shellEnvReady.then(() => profiles.warmUp());
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

  // Project resources: databases, APIs, links and logs for AI agents; secrets encrypted with safeStorage.
  const secretStore = new SecretStore(
    join(app.getPath('userData'), 'secrets.json'),
    safeStorage,
    createLogger('secrets'),
  );
  const resourceProjects = () => projects.list().map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath }));
  const resources = new ResourceService({
    file: join(app.getPath('userData'), 'project-resources.json'),
    secrets: secretStore,
    projects: resourceProjects,
    logger: createLogger('resources'),
  });
  const resourcesReady = Promise.all([secretStore.load(), resources.load()]).catch((e: unknown) =>
    log.error('Project resources could not be loaded', e),
  );

  const workspaceState = new WorkspaceStateService(
    join(app.getPath('userData'), 'workspaces'),
    createLogger('workspace'),
  );

  // Shell integration scripts are copied to userData (dotfiles for zsh, no asar/space issues) once per start.
  const shellScripts = installShellIntegration(
    join(appPaths.resourcesDir(), 'shell-integration'),
    join(app.getPath('userData'), 'shell-integration'),
  ).catch((e: unknown) => {
    log.warn('Shell integration scripts could not be installed', e);
    return null;
  });
  const terminals: TerminalService = new TerminalService({
    ptyHost: hosts.pty,
    profiles,
    shellIntegration: () => shellScripts,
    settings: () => settings.get(),
    resolveProject: (projectId) => {
      const project = projects.get(projectId);
      if (project)
        return {
          rootPath: project.rootPath,
          ...(project.settings.env ? { env: project.settings.env } : {}),
          ...(project.settings.defaultProfileId ? { defaultProfileId: project.settings.defaultProfileId } : {}),
        };
      // Pseudo-project used before any project is added (the default workspace).
      return projectId === DEFAULT_PROJECT_ID ? { rootPath: homedir() } : null;
    },
    baseEnv: () => shellEnvReady,
    readScrollback: async (projectId, panelId) => {
      if (!settings.get()['terminal.restoreScrollback']) return null;
      const saved = await workspaceState.readScrollback(projectId, panelId);
      return saved ? { data: saved.data, label: sessionRestoredLabel(saved.savedAt) } : null;
    },
    pluginEnv: (ctx): EnvLayer[] => pluginEnvLayers(pluginHost.environments(), ctx, process.platform),
    beforeSpawn: (): Promise<void> => pluginHost.envBarrier(),
    appVersion,
    dev: !app.isPackaged,
    platform: process.platform,
    logger: createLogger('terminals'),
  });

  // Claude Code session registry; CLAUDE_CONFIG_DIR may come from the login shell.
  const claudeRegistry = new ClaudeRegistry({
    dir: join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'sessions'),
    logger: createLogger('agents'),
    cliFallback: claudeAgentsCli(),
  });
  // Performance budget: process start → first terminal output.
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
  const files = new FileService({
    host: hosts.workspace,
    project: (id) => projects.get(id),
    settings: () => settings.get(),
    trash: (path) => shell.trashItem(path),
  });

  const userPluginsDir = join(app.getPath('userData'), 'plugins');
  const pluginInstaller = new PluginInstaller(userPluginsDir, createLogger('plugins'));
  const plugins = new PluginService({
    builtinDir: appPaths.builtinPluginsDir(),
    userDir: userPluginsDir,
    settings: () => settings.get(),
    updateSettings: (patch) => settings.update(patch),
    logger: createLogger('plugins'),
    ...(app.isPackaged ? { verifyBuiltin: verifyPluginChecksums } : {}),
  });
  const pluginsReady = pluginInstaller
    .cleanup()
    .then(() => plugins.scan())
    .catch((e: unknown) => log.error('Plugin discovery failed', e));
  /** Removes a plugin's entry from `plugins.enabled` (a user plugin is then disabled until the user consents). */
  const forgetPluginConsent = async (id: string) => {
    const current = settings.get()['plugins.enabled'];
    if (!(id in current)) return;
    const next = { ...current };
    delete next[id];
    await settings.update({ 'plugins.enabled': next });
  };
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
    openBuiltin: (req) => {
      if (mainWindow && !mainWindow.isDestroyed()) sendEvent(mainWindow.webContents, 'editor:openBuiltin', req);
    },
    platform: process.platform,
    logger: createLogger('editor'),
    dryRun: e2e,
  });

  // Created with the window below; tracks whether the shell document (main frame) has loaded.
  // Auto-update. E2E runs use a scripted backend, never the network.
  let updates: UpdateService | null = null;
  const updatesReady = (async () => {
    const updatesLog = createLogger('updates');
    let backend: UpdaterBackend | null = null;
    let disabledReason: string | undefined;
    if (e2e) backend = createE2eUpdateBackend(app.getPath('userData'));
    else {
      disabledReason =
        (await updateUnsupportedReason({
          isPackaged: app.isPackaged,
          platform: process.platform,
          env: process.env,
          resourcesPath: process.resourcesPath,
        })) ?? undefined;
      if (!disabledReason) {
        try {
          backend = await createElectronUpdaterBackend(updatesLog);
        } catch (e) {
          updatesLog.error('Could not load the updater', e);
          disabledReason = 'The updater could not be loaded.';
        }
      }
    }
    if (disabledReason) updatesLog.info(disabledReason);
    updates = new UpdateService({
      currentVersion: appVersion,
      backend,
      ...(disabledReason ? { disabledReason } : {}),
      settings: () => settings.get(),
      onDidChangeSettings: (listener) => settings.onDidChange(listener),
      requestQuit: () => app.quit(),
      logger: updatesLog,
    });
    return updates;
  })();
  let ptyPortLink: PtyPortLink | null = null;
  const quickPicks = new QuickPickBroker((request) => {
    if (!mainWindow || mainWindow.isDestroyed() || !ptyPortLink?.loaded) return false;
    sendEvent(mainWindow.webContents, 'ui:quickPick', request);
    return true;
  });
  const confirms = new RendererRequests<
    ConfirmRequest,
    { confirmed: boolean; checked: boolean; secondary?: boolean; value?: string }
  >(
    (request) => {
      if (!mainWindow || mainWindow.isDestroyed() || !ptyPortLink?.loaded) return false;
      sendEvent(mainWindow.webContents, 'ui:confirm', request);
      return true;
    },
    0,
    (requestId) => {
      if (mainWindow && !mainWindow.isDestroyed())
        sendEvent(mainWindow.webContents, 'ui:confirmDismiss', { requestId });
    },
  );
  // Toasts with buttons (plugins' `showNotification` actions); settled before the plugin's call times out.
  const notificationActions = new RendererRequests<NotificationPayload & { requestId: string }, string>(
    (request) => {
      if (!mainWindow || mainWindow.isDestroyed() || !ptyPortLink?.loaded) return false;
      sendEvent(mainWindow.webContents, 'notifications:show', request);
      return true;
    },
    45_000,
    // Withdrawn or timed out: the toast closes, so no button is left that does nothing.
    (requestId) => {
      if (mainWindow && !mainWindow.isDestroyed())
        sendEvent(mainWindow.webContents, 'notifications:dismiss', { requestId });
    },
  );

  const pluginDeps: Omit<PluginHostServiceDeps, 'host' | 'plugins' | 'logger'> = {
    env: {
      appVersion,
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      locale: app.getLocale() || 'en-US',
      homeDir: homedir(),
      userDataDir: app.getPath('userData'),
    },
    mcp: {
      addDynamicTool: (pluginId, definition) => mcpHub.addDynamicTool(pluginId, definition),
      removeDynamicTool: (pluginId, name) => mcpHub.removeDynamicTool(pluginId, name),
      dropDynamicTools: (pluginIds) => mcpHub.dropDynamicTools(pluginIds),
    },
    // E2E runs on slow CI machines can lengthen the start-up barrier for terminal environments (test-only).
    ...(e2e && process.env['OXYTOCIN_E2E_ENV_BARRIER_MS']
      ? { envBarrierMs: Number(process.env['OXYTOCIN_E2E_ENV_BARRIER_MS']) }
      : {}),
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
        markShown: (id) => terminals.markShown(id),
        kill: (id, force) => terminals.kill(id, force),
        close: (id) => terminals.close(id),
        watchOutput: (id, owner, watch) => terminals.watchOutput(id, owner, watch),
        unwatchAllOutput: (owner) => terminals.unwatchAllOutput(owner),
        listeningPorts: (id) => terminals.listeningPorts(id),
      },
      agents: {
        list: () => agents.list(),
        reportSession: (id, sessionId) => agents.reportSession(id, sessionId),
        reportState: (id, report) => agents.reportState(id, report),
      },
      git: { status: (id) => git.status(id) },
      settings: () => settings.get(),
      updateSettings: (patch) => settings.update(patch),
      openExternal: (url) => shell.openExternal(url),
      openInEditor: (req) => editor.open(req),
      quickPick: (items, options) => quickPicks.show(items, options),
      notifyWithActions: (payload, signal) => notificationActions.ask(payload, signal),
      toRenderer: (event, payload) => {
        const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
        if (!wc) return;
        if (event === 'toast') sendEvent(wc, 'notifications:show', payload as never);
        else if (event === 'openTerminalPanel') sendEvent(wc, 'terminals:openPanel', payload as never);
        else if (event === 'closeTerminalPanel') sendEvent(wc, 'terminals:closePanel', payload as never);
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
      agentBrief: (terminalId) => resourcesController.sessionBrief(terminalId),
    },
  };
  // Built-in plugins and user/developer plugins run in separate Plugin Hosts (ADR-022).
  const pluginHost = new PluginHosts(
    new PluginHostService({
      ...pluginDeps,
      host: hosts.plugin,
      plugins: scopedPlugins(plugins, true),
      logger: createLogger('plugins'),
    }),
    new PluginHostService({
      ...pluginDeps,
      host: hosts.externalPlugin,
      plugins: scopedPlugins(plugins, false),
      logger: createLogger('plugins-ext'),
    }),
    plugins,
  );
  // The external host starts once a user or developer plugin is enabled.
  const startExternalPluginHost = () => {
    if (hosts.externalPlugin.state === 'stopped' && plugins.enabled().some((p) => !runsInBuiltinHost(p)))
      hosts.externalPlugin.start();
  };
  plugins.onDidChange(startExternalPluginHost);
  void pluginsReady.then(() => {
    startExternalPluginHost();
    return pluginHost.reload();
  });
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
  // Project environment edited (project settings): its running terminals are out of date (⟳, 04 §2.4).
  let projectEnv = new Map(projects.list().map((p) => [p.id, JSON.stringify(p.settings.env ?? {})]));
  projects.onDidChange((list) => {
    const next = new Map(list.map((p) => [p.id, JSON.stringify(p.settings.env ?? {})]));
    for (const [id, env] of next) {
      if (!projectEnv.has(id) || projectEnv.get(id) === env) continue;
      for (const t of terminals.list(id)) if (t.state === 'running') terminals.markEnvStale(t.id);
    }
    projectEnv = next;
  });
  projects.onDidChangeActive((id) => pluginHost.notifyActiveProject(id));
  terminals.onDidUpdate((info) => pluginHost.notifyTerminal(info));
  terminals.onDidRemove((id) => pluginHost.notifyTerminalRemoved(id));
  terminals.onDidOutput(({ id, data }) => pluginHost.notifyTerminalOutput(id, data));
  agents.onDidUpdate((list) => pluginHost.notifyAgents(list));
  git.onDidChangeStatus((status) => pluginHost.notifyGitStatus(status));
  settings.onDidChange((s) => pluginHost.notifySettings(s));

  // Oxytocin's MCP server: core tools plus the tools plugins contribute (`contributes.mcp`).
  const mcpTokenStore = new JsonFileStore<{ token?: string | undefined }>({
    path: join(app.getPath('userData'), 'mcp.json'),
    schema: z.object({ token: z.string().min(16).optional() }),
    defaults: () => ({}),
    debounceMs: 0,
    logger: createLogger('mcp'),
  });
  mcpTokenStore.loadSync();
  const windowFocused = () => {
    const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyWindowFocused'] : undefined;
    if (typeof scripted === 'boolean') return scripted;
    return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused();
  };
  const osNotify = (title: string, body: string) => {
    const s = settings.get();
    if (!s['notifications.os'] || s['notifications.doNotDisturb']) return;
    pluginDeps.core.osNotify(title, body);
  };
  const toWindow = <C extends Parameters<typeof sendEvent>[1]>(
    channel: C,
    payload: Parameters<typeof sendEvent<C>>[2],
  ) => {
    if (mainWindow && !mainWindow.isDestroyed()) sendEvent(mainWindow.webContents, channel, payload);
  };
  const callerDeps = {
    terminal: (id: string) => {
      const t = terminals.get(id);
      return t ? { id: t.id, projectId: t.projectId, ...(t.agent ? { agentId: t.agent.agentId } : {}) } : undefined;
    },
    projects: () => projects.list().map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
    activeProjectId: () => projects.activeProjectId,
    findByPath: (path: string) => {
      const p = projects.findByPath(path);
      return p ? { id: p.id, name: p.name, rootPath: p.rootPath } : undefined;
    },
    realpath: (path: string) => realpath(path).catch(() => null),
    platform: process.platform,
  };
  const mcpToolSources = (): PluginToolSource[] =>
    plugins
      .list()
      .filter((p) => p.manifest?.contributes.mcp)
      .map((p) => {
        const mcp = p.manifest!.contributes.mcp!;
        const running = p.state === 'enabled' || p.state === 'active';
        return {
          pluginId: p.id,
          pluginName: p.displayName,
          builtin: p.source === 'builtin',
          prefix: mcp.prefix,
          declared: mcp.tools,
          available: running,
          ...(running
            ? {}
            : {
                unavailableReason:
                  p.state === 'failed'
                    ? `The plugin failed${p.errors?.length ? `: ${p.errors.at(-1)}` : '.'}`
                    : 'The plugin is turned off.',
              }),
        };
      });
  const resourcesController: ResourcesController = new ResourcesController({
    resources,
    secrets: secretStore,
    host: {
      call: (method, params, opts) => hosts.connections.call(method, params as never, opts) as never,
      running: () => hosts.connections.state === 'running' || hosts.connections.state === 'starting',
      start: () => hosts.ensureConnections(),
      stop: () => hosts.connections.stop(),
    },
    projects: resourceProjects,
    terminalProject: (id) => terminals.get(id)?.projectId,
    runProfileUrl: async (projectId, profileId) => {
      const url = await pluginHost.executeCommand('oxytocin.project-runner.resolveUrl', [{ projectId, profileId }]);
      return typeof url === 'string' && url ? url : null;
    },
    confirm: async ({ title, description, details, code, confirmLabel, cancelLabel, tone, signal }) => {
      if (!windowFocused()) osNotify(title, description);
      const answer = await confirms.ask(
        {
          title,
          description: description.slice(0, 2000),
          ...(details?.length ? { details: details.map((d) => d.slice(0, 500)) } : {}),
          ...(code ? { code: code.length > 20_000 ? `${code.slice(0, 20_000)}…` : code } : {}),
          confirmLabel,
          cancelLabel,
          tone,
          destructive: tone === 'danger',
        },
        signal,
      );
      return answer ? answer.confirmed : null;
    },
    logger: createLogger('resources'),
  });
  // Repository resources (`.oxytocin/project.json`) are offered when a project is opened.
  const checkRepository = (id: string | null) => {
    if (id) void resourcesReady.then(() => resourcesController.checkRepositoryConfig(id));
  };
  projects.onDidChangeActive(checkRepository);

  const mcpHub: McpHub = new McpHub({
    settings: () => settings.get(),
    onDidChangeSettings: (listener) => settings.onDidChange(listener),
    updateSettings: (patch) => settings.update(patch),
    tokenStore: {
      get: () => mcpTokenStore.get().token,
      set: async (token) => {
        mcpTokenStore.set({ token });
        await mcpTokenStore.flush();
      },
    },
    appVersion,
    core: {
      projects: () => projects.list().map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
      activeProjectId: () => projects.activeProjectId,
      branch: (id) => git.status(id)?.branch?.head ?? undefined,
      terminals: (projectId) => terminals.list(projectId),
      terminalText: (id) => hosts.pty.call('getText', { id }),
      notify: ({ title, message, level }) => {
        toWindow('notifications:show', { kind: level, message, description: title });
        if (!windowFocused()) osNotify(title, message);
      },
      ask: async ({ title, question, options, placeholder, timeoutMs, signal }) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        if (!windowFocused()) osNotify(title, question);
        const answer = await confirms.ask(
          {
            title,
            description: question,
            input: options ? { kind: 'options', options } : { kind: 'text', ...(placeholder ? { placeholder } : {}) },
            confirmLabel: 'Answer',
            cancelLabel: 'Dismiss',
            tone: 'info',
          },
          AbortSignal.any([signal, timeout]),
        );
        return answer?.confirmed && answer.value !== undefined ? answer.value : null;
      },
      openFile: ({ projectId, path, line }) => {
        toWindow('mcp:openFile', { projectId, path, ...(line ? { line } : {}) });
        return Promise.resolve();
      },
      isFile: async (path) => (await stat(path).catch(() => null))?.isFile() ?? false,
      platform: process.platform,
    },
    caller: callerDeps,
    describeTerminal: (id) => {
      const t = terminals.get(id);
      if (!t) return undefined;
      const project = projects.get(t.projectId)?.name;
      return project ? `${t.title} · ${project}` : t.title;
    },
    plugins: {
      sources: mcpToolSources,
      onDidChange: (listener) => plugins.onDidChange(() => listener()),
      call: (o): Promise<McpToolResult> => pluginHost.callMcpTool(o),
      setProblems: (problems) => plugins.setProblems(problems),
    },
    askPolicy: async ({ toolTitle, toolName, source, caller, args, signal }) => {
      const who = caller ? `An agent in ${caller}` : 'An agent';
      if (!windowFocused()) osNotify(`Allow ${toolTitle}?`, `${who} wants to use ${toolName} (${source}).`);
      const code = JSON.stringify(args, null, 2);
      const answer = await confirms.ask(
        {
          title: `Allow ${toolTitle}?`,
          description: `${who} wants to use ${toolName} (${source}).`,
          ...(code !== '{}' ? { code: code.length > 20_000 ? `${code.slice(0, 20_000)}…` : code } : {}),
          confirmLabel: 'Allow once',
          secondaryLabel: 'Always allow',
          cancelLabel: 'Deny',
          tone: 'warning',
        },
        signal,
      );
      if (!answer) return null;
      return answer.secondary ? 'always' : answer.confirmed ? 'once' : 'deny';
    },
    cli: createCliRunner(
      () => settings.get()['mcp.claudeCommand'] || 'claude',
      () => shellEnv,
    ),
    logger: createLogger('mcp'),
    resources: {
      tools: resourcesController.tools,
      kinds: () => resources.kinds(),
      onDidChange: (listener) => resources.onDidChange(() => listener()),
      brief: (projectId) => resourcesController.brief(projectId),
    },
  });
  void Promise.all([pluginsReady, resourcesReady]).then(() => mcpHub.start());

  // Ensemble: tasks run by a team of AI agents in background terminals, through `/mcp/ensemble`.
  let ensembleNotify:
    | ((o: {
        title: string;
        body: string;
        level: 'info' | 'warning' | 'error';
        projectId: string;
        taskId: string;
      }) => void)
    | null = null;
  const ensemble = new EnsembleService({
    dir: join(app.getPath('userData'), 'ensemble'),
    logger: createLogger('ensemble'),
    settings: () => settings.get(),
    projects: {
      get: (id) => {
        const p = projects.get(id);
        return p ? { id: p.id, name: p.name, rootPath: p.rootPath } : undefined;
      },
    },
    terminals,
    agents,
    pty: {
      paste: (id, text, submit) => hosts.pty.call('paste', { id, text, submit }),
      write: (id, data) => hosts.pty.call('write', { id, data }),
      text: (id) => hosts.pty.call('getText', { id }),
      onActivity: (listener) => hosts.pty.onEvent('terminal:activity', listener),
    },
    workspace: (method, params, opts) => hosts.workspace.call(method, params as never, opts) as never,
    mcp: {
      url: () => mcpHub.ensembleUrl(),
      status: () => mcpHub.serverStatus(),
      endSessions: (token) => mcpHub.endEnsembleSessions(token),
    },
    detect: (command) => detectCommand(command, () => shellEnv),
    bridgeEnabled: () => {
      const p = plugins.get('oxytocin.claude-code-bridge');
      return p?.state === 'enabled' || p?.state === 'active';
    },
    notify: (o) => ensembleNotify?.(o),
    platform: process.platform,
    usage: async (groups) => {
      if (plugins.get('oxytocin.usage-monitor')?.state !== 'active') throw new Error('The Usage Monitor is not active');
      return UsageTotalsSchema.parse(await pluginHost.executeCommand('oxytocin.usage-monitor.totals', [{ groups }]));
    },
  });
  mcpHub.setEnsemble({
    describe: (token) => ensemble.describe(token),
    tools: () => ensemble.tools(),
    call: (name, args, o) => ensemble.callTool(name, args, o),
    instructions: () => ensemble.instructions(),
  });
  void projectsReady.then(() => ensemble.ready);
  // The resource tools are listed once the resources are loaded (and whenever projects come and go).
  void resourcesReady.then(() => resources.touch());
  projects.onDidChange(() => resources.touch());

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
      'updates:getState': async () => (await updatesReady).get(),
      'updates:check': async () => (await updatesReady).check(),
      'updates:restart': async () => (await updatesReady).restartToUpdate(),
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
        await resources.removeProject(id);
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
      'ui:confirmResult': ({ requestId, confirmed, checked, secondary, value }) =>
        confirms.settle(requestId, {
          confirmed,
          checked,
          ...(secondary ? { secondary } : {}),
          ...(value !== undefined ? { value } : {}),
        }),
      'notifications:action': ({ requestId, actionId }) => notificationActions.settle(requestId, actionId),
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
      'git:action': ({ projectId, action }) => git.action(projectId, action),
      'git:branches': ({ projectId }) => git.branches(projectId),
      'files:list': ({ projectId, path }) => files.list(projectId, path),
      'files:find': ({ projectId }) => files.find(projectId),
      'files:stat': ({ projectId, path }) => files.stat(projectId, path),
      'files:read': ({ projectId, path }) => files.read(projectId, path),
      'files:write': (req) => files.write(req),
      'files:create': ({ projectId, path, kind }) => files.create(projectId, path, kind),
      'files:rename': ({ projectId, from, to }) => files.rename(projectId, from, to),
      'files:trash': ({ projectId, path }) => files.trash(projectId, path),
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
      'plugins:install': async ({ kind }) => {
        const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyPickPluginAnswer'] : undefined;
        let source: string | null;
        if (typeof scripted === 'string' || scripted === null) source = scripted;
        else {
          const result = await dialog.showOpenDialog(
            win,
            kind === 'zip'
              ? {
                  title: 'Install plugin from a .zip file',
                  properties: ['openFile'],
                  filters: [{ name: 'Plugin archive', extensions: ['zip'] }],
                }
              : { title: 'Install plugin from a folder', properties: ['openDirectory'] },
          );
          source = result.canceled ? null : (result.filePaths[0] ?? null);
        }
        if (!source) return null;
        await pluginsReady;
        const installed = await pluginInstaller.install(source);
        // New permissions or a new Node backend: disabled until the user agrees again.
        if (installed.needsNewConsent) await forgetPluginConsent(installed.id);
        await plugins.scan();
        if (installed.replaced) await pluginHost.reloadPlugin(installed.id);
        return installed;
      },
      'plugins:uninstall': async ({ id }) => {
        const plugin = plugins.get(id);
        if (!plugin || plugin.source !== 'user')
          throw new OxyError('INVALID', 'Only plugins you installed can be uninstalled');
        // Unload it from the Plugin Host before its files go away.
        await plugins.setEnabled(id, false);
        await pluginHost.reload();
        await pluginInstaller.uninstall(id, plugin.path);
        await forgetPluginConsent(id);
        await plugins.scan();
      },
      'plugins:openUserFolder': async () => {
        await mkdir(userPluginsDir, { recursive: true });
        if (!e2e) await shell.openPath(userPluginsDir);
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
      'plugins:statusBar': () => pluginHost.statusBarItems(),
      'plugins:viewClosed': ({ viewId }) => pluginHost.viewClosed(viewId),
      'plugins:viewVisibility': ({ viewId, visible }) => pluginHost.viewVisibility(viewId, visible),
      'plugins:viewMessage': ({ viewId, envelope }) => pluginHost.viewMessage(viewId, envelope),
      'mcp:getState': () => mcpHub.state(),
      'mcp:connectClaude': () => mcpHub.connectClaude(),
      'mcp:disconnectClaude': () => mcpHub.disconnectClaude(),
      'mcp:checkClaude': () => mcpHub.checkClaude(),
      'mcp:clientConfig': () => mcpHub.clientConfig(),
      'mcp:resetToken': () => mcpHub.resetToken(),
      'mcp:clearLog': () => mcpHub.clearLog(),
      'resources:get': async ({ projectId }) => {
        await resourcesReady;
        return resourcesController.get(projectId);
      },
      'resources:save': async ({ projectId, resources: input, secrets }) => {
        await resourcesReady;
        return resourcesController.save(projectId, input, secrets);
      },
      'resources:test': async (req) => {
        await resourcesReady;
        return resourcesController.test(req);
      },
      'resources:import': ({ projectId }) => resourcesController.importCandidates(projectId),
      'resources:brief': async ({ projectId }) => {
        await resourcesReady;
        return { text: resourcesController.brief(projectId) };
      },
      'resources:writeInstructions': ({ projectId, file }) => resourcesController.writeInstructions(projectId, file),
      'resources:saveToRepository': async ({ projectId }) => ({
        path: await resourcesController.saveToRepository(projectId),
      }),
      'resources:pickFile': async ({ projectId, purpose }) => {
        const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyPickFileAnswer'] : undefined;
        let picked: string | null;
        if (typeof scripted === 'string' || scripted === null) picked = scripted;
        else {
          const filters: Record<typeof purpose, Electron.FileFilter[]> = {
            sqlite: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 's3db'] }],
            env: [{ name: 'Env file', extensions: ['env', '*'] }],
            log: [{ name: 'Log file', extensions: ['log', 'txt', '*'] }],
            openapi: [{ name: 'OpenAPI document', extensions: ['json', 'yaml', 'yml'] }],
            certificate: [{ name: 'Certificate', extensions: ['pem', 'crt', 'cer'] }],
          };
          const project = projects.get(projectId);
          const result = await dialog.showOpenDialog(win, {
            title: 'Choose a file',
            ...(project ? { defaultPath: project.rootPath } : {}),
            properties: ['openFile', 'showHiddenFiles'],
            filters: [...filters[purpose], { name: 'All files', extensions: ['*'] }],
          });
          picked = result.canceled ? null : (result.filePaths[0] ?? null);
        }
        return picked ? resourcesController.relativePath(projectId, picked) : null;
      },
      'secrets:status': async ({ projectId }) => {
        await resourcesReady;
        return secretStore.status(projectId);
      },
      'secrets:set': async ({ projectId, resourceId, key, value }) => {
        await resourcesReady;
        const r = resources.get(projectId);
        if (![...r.databases, ...r.apis].some((x) => x.id === resourceId))
          throw new OxyError('INVALID', `No database or API ${resourceId} in this project.`);
        await secretStore.set(projectId, resourceId, key, value);
        return secretStore.status(projectId);
      },
      'ensemble:list': async ({ projectId }) => {
        await ensemble.ready;
        return ensemble.list(projectId);
      },
      'ensemble:create': (req) => ensemble.create(req),
      'ensemble:createQuick': (req) => ensemble.createQuick(req),
      'ensemble:save': async ({ task }) => {
        await ensemble.ready;
        return ensemble.save(task);
      },
      'ensemble:delete': ({ taskId }) => ensemble.remove(taskId),
      'ensemble:duplicate': ({ taskId }) => ensemble.duplicate(taskId),
      'ensemble:command': ({ taskId, event }) => ensemble.command(taskId, event),
      'ensemble:answer': ({ taskId, questionId, answer }) => ensemble.answer(taskId, questionId, answer),
      'ensemble:checks': ({ projectId, clis }) => ensemble.checks(projectId, clis),
      'ensemble:changes': ({ taskId, from, to }) => ensemble.changes(taskId, from, to),
      'ensemble:fileDiff': ({ taskId, path, oldPath, from, to }) =>
        ensemble.fileDiff(taskId, path, { oldPath, from, to }),
      'ensemble:finish': ({ taskId, action }) => ensemble.finish(taskId, action),
      'ensemble:report': ({ taskId }) => ({ text: ensemble.report(taskId) }),
      'ensemble:openFolder': async ({ taskId, target }) => {
        const record = ensemble.get(taskId);
        const folder =
          record?.run.worktree?.path ?? (record ? projects.get(record.task.projectId)?.rootPath : undefined);
        if (!folder) throw new OxyError('NOT_FOUND', 'The task has no working folder yet.');
        if (target === 'editor') await editor.open({ path: folder });
        else if (!e2e) await shell.openPath(folder);
      },
      'secrets:delete': async ({ projectId, resourceId, key }) => {
        await resourcesReady;
        await secretStore.delete(projectId, resourceId, key);
        return secretStore.status(projectId);
      },
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

  installAppMenu({
    platform: process.platform,
    appName: app.getName(),
    dev: !app.isPackaged,
    run: (command) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      sendEvent(mainWindow.webContents, 'app:menuCommand', { command });
    },
    openLogsFolder: () => void shell.openPath(dirname(logFilePath())),
  });

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
  mcpHub.onDidChangeState((state) => sendEvent(win.webContents, 'mcp:state', state));
  resourcesController.onDidChange((projectId) => sendEvent(win.webContents, 'resources:changed', { projectId }));
  ensemble.onDidChange((record: EnsembleRecord) => sendEvent(win.webContents, 'ensemble:changed', record));
  ensemble.onDidRemove((e) => sendEvent(win.webContents, 'ensemble:removed', e));
  // The first project shown is checked once the window can show the question.
  win.webContents.once(
    'did-finish-load',
    () => void projectsReady.then(() => checkRepository(projects.activeProjectId)),
  );
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
  void updatesReady.then((u) => {
    u.onDidChange((state) => sendEvent(win.webContents, 'updates:state', state));
    u.start();
  });

  // Attention system.
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
    // Ensemble agents and commands report through the Ensemble inbox, not one toast per terminal.
    muted: (terminalId) => ensemble.ownsTerminal(terminalId),
  });
  ensembleNotify = ({ title, body, level, projectId, taskId }) => {
    const open = () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      void projects
        .setActive(projectId)
        .catch(() => undefined)
        .then(() => sendEvent(win.webContents, 'ensemble:open', { projectId, taskId }));
    };
    sendEvent(win.webContents, 'ensemble:notify', { title, body, level, projectId, taskId });
    const scripted = e2e ? (globalThis as Record<string, unknown>)['__oxyWindowFocused'] : undefined;
    const focused = typeof scripted === 'boolean' ? scripted : win.isFocused();
    const s = settings.get();
    if (focused || !s['notifications.os'] || s['notifications.doNotDisturb']) return;
    if (e2e) {
      osNotifications.push({ title, body, click: open });
      return;
    }
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: appPaths.windowIcon() });
    liveNotifications.add(n);
    n.on('click', () => {
      liveNotifications.delete(n);
      open();
    });
    n.on('close', () => liveNotifications.delete(n));
    n.show();
  };
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
  // and PTY Host restarts.
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
    confirms.cancelAll();
    notificationActions.cancelAll();
  });
  // A crashed renderer reloads by itself (terminals and agents live in the hosts and reattach); a hung one offers
  // a reload. Native dialogs: the page cannot show its own.
  const scriptedRecovery = (key: string) => {
    const answer = e2e ? (globalThis as Record<string, unknown>)[key] : undefined;
    return typeof answer === 'string' ? answer : undefined;
  };
  const recovery = new RendererRecovery({
    isDestroyed: () => win.isDestroyed() || win.webContents.isDestroyed(),
    reload: () => win.webContents.reload(),
    quit: () => app.quit(),
    askAfterCrashes: async (crashes) => {
      const scripted = scriptedRecovery('__oxyCrashLoopAnswer');
      if (e2e) return scripted === 'quit' ? 'quit' : 'reload';
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        message: 'The Oxytocin window stopped working',
        detail: `It crashed ${crashes} times in a row. Your terminals and agents keep running; reloading reconnects to them.`,
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1 ? 'quit' : 'reload';
    },
    askWhenUnresponsive: async (signal) => {
      // Tests never get a native dialog by surprise (a slow CI machine can miss the responsiveness deadline).
      if (e2e) return scriptedRecovery('__oxyUnresponsiveAnswer') === 'reload' ? 'reload' : 'wait';
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Oxytocin is not responding',
        detail: 'Your terminals and agents keep running. You can wait or reload the window.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        signal,
      });
      return response === 1 ? 'reload' : 'wait';
    },
    logger: createLogger('window'),
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    link.shellDidUnload();
    quickPicks.cancelAll();
    confirms.cancelAll();
    notificationActions.cancelAll();
    // While quitting the window goes away on purpose.
    if (!quitting) recovery.onGone(details);
  });
  win.on('unresponsive', () => {
    if (!quitting) recovery.onUnresponsive();
  });
  win.on('responsive', () => recovery.onResponsive());
  win.on('closed', () => {
    recovery.dispose();
    quickPicks.cancelAll();
    confirms.cancelAll();
    notificationActions.cancelAll();
  });
  hosts.pty.onDidBecomeReady(() => link.hostDidBecomeReady());

  // Quit sequence: QuitGuard → flush layouts → scrollback snapshots → hosts.
  let quitting = false;
  let lastQuitPrompt: QuitPrompt | null = null;
  let quitInProgress = false;
  const quitGuard = async (): Promise<boolean> => {
    if (!settings.get()['terminal.confirmOnQuit']) return true;
    const busy = busyTerminals(terminals.list());
    if (busy.length === 0) return true;
    const prompt = describeQuit(busy, (id) => projects.get(id)?.name);
    const { message, detail } = prompt;
    if (e2e) {
      lastQuitPrompt = prompt;
      // Tests answer through a global ('dialog' shows the real dialog): Playwright's app.close() must not wait.
      const answer = (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'];
      if (answer !== 'dialog') return answer !== 'cancel';
    }
    // The window's own dialog; the native one only when the window cannot show it (renderer gone).
    if (!win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const answer = await confirms.ask({
      title: prompt.title,
      description: prompt.description,
      details: prompt.items,
      confirmLabel: 'Quit',
      destructive: true,
      tone: 'warning',
      checkbox: { label: "Don't ask again", defaultChecked: false },
    });
    if (answer) {
      if (!answer.confirmed) return false;
      if (answer.checked) await settings.update({ 'terminal.confirmOnQuit': false });
      return true;
    }
    if (win.isDestroyed()) return true;
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
  /** Files edited in the built-in editor but not saved: save them, drop them, or stay. */
  const unsavedGuard = async (): Promise<boolean> => {
    if (win.isDestroyed() || e2e) return true;
    const files = (await withTimeout(
      win.webContents.executeJavaScript('window.__oxyUnsavedFiles ? window.__oxyUnsavedFiles() : []', true),
      2000,
    ).catch(() => undefined)) as unknown;
    if (!Array.isArray(files) || files.length === 0) return true;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const answer = await confirms.ask({
      title: 'Save your changes before quitting?',
      description: `${files.length === 1 ? 'A file has' : `${files.length} files have`} unsaved edits.`,
      details: files.slice(0, 20).map(String),
      confirmLabel: 'Save and quit',
      secondaryLabel: "Don't save",
      tone: 'warning',
    });
    if (!answer) return true;
    if (!answer.confirmed) return false;
    if (answer.secondary) return true;
    const saved: unknown = await withTimeout(
      win.webContents.executeJavaScript('window.__oxySaveAll ? window.__oxySaveAll() : true', true) as Promise<unknown>,
      10_000,
    ).catch(() => false);
    return saved === true;
  };
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
        if (!(await unsavedGuard()) || !(await quitGuard())) {
          updates?.cancelRestart();
          return;
        }
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
            // Only reached on a slow disk (antivirus scanning the new files); the snapshots are taken first.
            6000,
          ).catch((e: unknown) => log.warn('Failed to persist scrollback', e));
        }
        // Open SSE streams would keep the MCP server from closing.
        await withTimeout(mcpHub.stop(), 2000).catch(() => undefined);
        resourcesController.dispose();
        await withTimeout(ensemble.flush(), 3000).catch(() => undefined);
        await Promise.all([uiState.flush(), projects.flush(), resources.flush(), secretStore.flush(), hosts.stopAll()]);
      } catch (e) {
        log.error('Error during quit', e);
      } finally {
        quitInProgress = false;
        if (quitting) {
          settings.dispose();
          // A downloaded update installs now; the updater then quits the app itself (fallback exit below).
          if (updates?.installOnQuit()) setTimeout(() => app.exit(0), 10_000);
          else app.exit(0);
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
      updates: () => updates,
      mcp: mcpHub,
      confirms,
      resources,
      resourcesController,
      secretStore,
      ensemble,
    };
  }
}

void app
  .whenReady()
  .then(bootstrap)
  .catch((e: unknown) => {
    // Without a window the process would linger invisibly and hold the single-instance lock, so a new start
    // would only focus nothing. Report it and exit instead.
    try {
      createLogger('main').error('Oxytocin could not start', e);
      dialog.showErrorBox(
        'Oxytocin could not start',
        `${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n\nThe log is in ${logFilePath()}.`,
      );
    } finally {
      app.exit(1);
    }
  });

app.on('window-all-closed', () => app.quit());
