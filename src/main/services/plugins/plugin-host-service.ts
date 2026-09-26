import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { RepoStatus } from '@shared/domain/git';
import { type PluginDescriptor, type PluginPermission } from '@shared/domain/plugin';
import { type Project, PROJECT_COLOR_VALUES } from '@shared/domain/project';
import type { Settings } from '@shared/domain/settings';
import type { TerminalInfo } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import type {
  HostApiEnv,
  HostPluginInfo,
  PluginHostEvents,
  PluginHostMethods,
  OpenViewRequest,
  PluginLogEntry,
  ViewEnvelope,
} from '@shared/rpc/contracts/plugin-host';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { UtilityHost } from '../../hosts/utility-host';
import { collectContributions } from './discovery';
import { configDefaults, validateConfigValue } from './contributions';
import type { PluginService } from './plugin-service';

export interface StatusBarItemState {
  pluginId: string;
  id: string;
  text: string;
  tooltip?: string;
  color?: 'default' | 'success' | 'warning' | 'danger' | 'accent';
  command?: string | { id: string; args?: unknown[] };
  visible: boolean;
}

export interface EnvContribution {
  pluginId: string;
  description?: string;
  entries: {
    op: 'replace' | 'append' | 'prepend' | 'delete';
    name: string;
    value?: string;
    scope?: { projectId?: string; profileIds?: string[] };
    /** append/prepend: inserted only when the variable already has a value. */
    separator?: string;
  }[];
}

/** Core services the plugin API reaches (kept narrow for tests). */
export interface PluginCorePort {
  projects: {
    list(): Project[];
    get(id: string): Project | undefined;
    activeId(): string | null;
    findByPath(path: string): Project | undefined;
  };
  terminals: {
    list(projectId?: string): TerminalInfo[];
    get(id: string): TerminalInfo | undefined;
    create(req: {
      projectId: string;
      profileId?: string;
      cwd?: string;
      userTitle?: string;
      initialCommand?: string;
    }): Promise<TerminalInfo>;
    write(id: string, data: string): Promise<void>;
  };
  agents: { list(): AgentInfoWithTerminal[]; reportSession(terminalId: string, sessionId: string): void };
  git: { status(projectId: string): RepoStatus | null };
  settings(): Settings;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
  openExternal(url: string): Promise<void>;
  openInEditor(req: { path: string; line?: number; column?: number }): Promise<void>;
  /** Renderer-side effects (toasts, panels, core commands). */
  toRenderer(
    event: 'toast' | 'openTerminalPanel' | 'runCommand' | 'viewMessage' | 'viewMeta' | 'openPanel' | 'pluginReloaded',
    payload: unknown,
  ): void;
  osNotify(title: string, body: string): void;
}

export interface PluginHostServiceDeps {
  host: Pick<
    UtilityHost<PluginHostMethods, PluginHostEvents>,
    'call' | 'onEvent' | 'onDidBecomeReady' | 'serve' | 'emit' | 'state'
  >;
  plugins: Pick<PluginService, 'enabled' | 'get' | 'onDidChange' | 'setRuntimeState'>;
  core: PluginCorePort;
  env: HostApiEnv;
  logger: Logger;
}

/** Core commands plugins may execute (docs/plan/07-plugin-engine.md §6.4). */
const CORE_COMMANDS = new Set([
  'oxytocin.terminal.new',
  'oxytocin.terminal.focus',
  'oxytocin.project.activate',
  'oxytocin.diff.open',
  'oxytocin.changes.refresh',
  'oxytocin.panel.focus',
]);

const MAX_HANG_INCIDENTS = 2;
/** New terminals wait at most this long after start-up for plugin environments (07 §8.7). */
const ENV_BARRIER_MS = 2000;
/** docs/plan/07-plugin-engine.md §7.5 */
const MAX_VIEW_MESSAGE_BYTES = 1024 * 1024;
const MAX_VIEW_MESSAGES_PER_SECOND = 200;

export function toTerminalMeta(t: TerminalInfo) {
  return {
    id: t.id,
    projectId: t.projectId,
    profileId: t.profileId,
    title: t.title,
    ...(t.pid !== null ? { pid: t.pid } : {}),
    status: t.state === 'running' ? ('running' as const) : ('exited' as const),
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    kind: t.kind,
    ...(t.agent ? { agentId: t.agent.agentId } : {}),
    createdAt: t.createdAt,
  };
}

export function toProjectInfo(p: Project) {
  return {
    id: p.id,
    name: p.name,
    rootPath: p.rootPath,
    color: PROJECT_COLOR_VALUES[p.color] ?? PROJECT_COLOR_VALUES[0],
  };
}

function toHostInfo(p: PluginDescriptor): HostPluginInfo | null {
  const m = p.manifest;
  if (!m) return null;
  const join = (rel: string) => `${p.path.replace(/[\\/]+$/, '')}${p.path.includes('\\') ? '\\' : '/'}${rel}`;
  return {
    id: p.id,
    version: p.version,
    path: p.path,
    ...(m.main ? { main: join(m.main) } : {}),
    builtin: p.source === 'builtin',
    permissions: m.permissions,
    activationEvents: m.activationEvents,
    commands: m.contributes.commands.map((c) => c.id),
    views: m.contributes.views.map((v) => v.id),
    panels: m.contributes.panels.map((v) => v.type),
    statusBarItems: m.contributes.statusBarItems.map((v) => v.id),
    ...(m.contributes.configuration ? { configurationPrefix: m.contributes.configuration.prefix } : {}),
  };
}

/**
 * Main side of the plugin engine (docs/plan/07-plugin-engine.md §6): loads enabled plugins into the Plugin Host,
 * fires activation events, serves the plugin API (`api:call`, permissions checked again here), forwards core
 * events and attributes hangs to the plugin that was running.
 */
export class PluginHostService implements Disposable {
  private readonly store = new DisposableStore();
  private busy: string | null = null;
  private readonly incidents = new Map<string, number>();
  private readonly excluded = new Set<string>();
  private loaded = '';
  private loading: Promise<void> = Promise.resolve();
  private lastSettings: Record<string, unknown> = {};
  private readonly knownTerminals = new Set<string>();
  readonly statusBarItems = new Map<string, StatusBarItemState>();
  private readonly statusEmitter = new Emitter<StatusBarItemState[]>();
  readonly onDidChangeStatusBar = this.statusEmitter.event;
  readonly environments = new Map<string, EnvContribution>();
  private readonly openViews = new Map<string, OpenViewRequest>();
  /** Resolves when the host knows the view (messages sent earlier would be lost). */
  private readonly viewReady = new Map<string, Promise<void>>();
  private readonly viewRates = new Map<string, { windowStart: number; count: number }>();
  readonly envReady = new Set<string>();
  private readonly envEmitter = new Emitter<EnvContribution[]>();
  private readonly startedAt = Date.now();
  private barrierWaiters: (() => void)[] = [];
  readonly onDidChangeEnvironment = this.envEmitter.event;

  constructor(private readonly deps: PluginHostServiceDeps) {
    const host = deps.host;
    this.store.add(
      host.serve({ 'api:call': (req: { pluginId: string; method: string; params: unknown }) => this.apiCall(req) }),
    );
    this.store.add(
      host.onEvent('plugin:state', ({ id, state, error }) => {
        if (state === 'inactive') this.clearPluginUi(id);
        deps.plugins.setRuntimeState(id, state, error);
        this.checkBarrier();
      }),
    );
    this.store.add(host.onEvent('plugin:busy', ({ id }) => (this.busy = id)));
    this.store.add(host.onEvent('view:message', (e) => deps.core.toRenderer('viewMessage', e)));
    this.store.add(host.onEvent('view:meta', (e) => deps.core.toRenderer('viewMeta', e)));
    this.store.add(
      host.onDidBecomeReady(({ restarted }) => {
        if (restarted) this.onHostRestarted();
        this.loaded = '';
        void this.reload();
      }),
    );
    this.store.add(deps.plugins.onDidChange(() => void this.reload()));
  }

  private onHostRestarted(): void {
    const suspect = this.busy;
    this.busy = null;
    for (const id of [...this.statusBarItems.values()].map((s) => s.pluginId)) this.clearPluginUi(id);
    if (!suspect) return;
    const count = (this.incidents.get(suspect) ?? 0) + 1;
    this.incidents.set(suspect, count);
    this.deps.logger.warn(`Plugin ${suspect} was running when the Plugin Host stopped responding (${count}×)`);
    if (count >= MAX_HANG_INCIDENTS) {
      this.excluded.add(suspect);
      this.deps.plugins.setRuntimeState(
        suspect,
        'failed',
        'Stopped responding twice — not loaded until the app restarts',
      );
    }
  }

  private hostInfos(): HostPluginInfo[] {
    return this.deps.plugins
      .enabled()
      .filter((p) => !this.excluded.has(p.id) && p.state !== 'failed')
      .map(toHostInfo)
      .filter((p): p is HostPluginInfo => p !== null);
  }

  /** Sends the current plugin set to the host and fires `onStartup` for new plugins. */
  reload(): Promise<void> {
    this.loading = this.loading.then(async () => {
      if (this.deps.host.state !== 'running') return;
      const infos = this.hostInfos();
      const key = JSON.stringify(infos);
      if (key === this.loaded) return;
      this.loaded = key;
      this.lastSettings = this.settingsWithDefaults(this.deps.core.settings());
      try {
        await this.deps.host.call('plugins:load', { plugins: infos, settings: this.lastSettings, env: this.deps.env });
        await this.activateByEvent('onStartup');
        if (this.deps.core.projects.activeId()) await this.activateByEvent('onProjectOpen');
        // Views that stayed mounted (host restart, reload): resolve them again.
        for (const view of [...this.openViews.values()]) {
          if (infos.some((i) => i.id === view.pluginId)) await this.openInHost(view);
        }
      } catch (e) {
        this.deps.logger.warn('Loading plugins failed', e);
      }
      for (const id of [...this.statusBarItems.values()].map((s) => s.pluginId))
        if (!infos.some((i) => i.id === id)) this.clearPluginUi(id);
      for (const id of [...this.environments.keys()])
        if (!infos.some((i) => i.id === id)) this.setEnvironment(id, null);
    });
    return this.loading;
  }

  /**
   * Plugins → Reload / dev auto-reload: gives a failed or excluded plugin another chance, reloads its module in
   * the host and tells the renderer to reload its views.
   */
  async reloadPlugin(id: string): Promise<void> {
    this.excluded.delete(id);
    this.incidents.delete(id);
    if (this.deps.plugins.get(id)?.state === 'failed') this.deps.plugins.setRuntimeState(id, 'inactive');
    await this.reload();
    if (this.deps.host.state === 'running' && this.hostInfos().some((p) => p.id === id)) {
      try {
        await this.deps.host.call('plugins:reload', { id }, { timeoutMs: 30_000 });
      } catch (e) {
        this.deps.logger.warn(`Reloading plugin ${id} failed`, e);
      }
    }
    this.deps.core.toRenderer('pluginReloaded', { id });
  }

  async activateByEvent(event: string): Promise<string[]> {
    if (this.deps.host.state !== 'running') return [];
    try {
      return await this.deps.host.call('plugins:activateByEvent', { event }, { timeoutMs: 30_000 });
    } catch (e) {
      this.deps.logger.warn(`Activation event ${event} failed`, e);
      return [];
    }
  }

  async executeCommand(id: string, args: unknown[]): Promise<unknown> {
    return this.deps.host.call('commands:execute', { id, args }, { timeoutMs: 60_000 });
  }

  async logs(id: string): Promise<PluginLogEntry[]> {
    if (this.deps.host.state !== 'running') return [];
    return await this.deps.host.call('plugins:logs', { id });
  }

  // ── start-up barrier for terminal environments (07 §8.7) ──

  private barrierOpen(): boolean {
    if (Date.now() - this.startedAt >= ENV_BARRIER_MS) return true;
    const waiting = this.deps.plugins.enabled().filter((p) => {
      const m = p.manifest;
      if (!m?.permissions.includes('terminals.env')) return false;
      if (!m.activationEvents.some((e) => e === 'onStartup' || e === '*')) return false;
      return !this.envReady.has(p.id) && p.state !== 'active' && p.state !== 'failed';
    });
    return waiting.length === 0;
  }

  private checkBarrier(): void {
    if (this.barrierWaiters.length === 0 || !this.barrierOpen()) return;
    for (const resolve of this.barrierWaiters.splice(0)) resolve();
  }

  /**
   * Resolves when every enabled `onStartup` plugin with `terminals.env` has declared its environment ready
   * (or finished activating) — at most 2 s after start-up.
   */
  envBarrier(): Promise<void> {
    if (this.barrierOpen()) return Promise.resolve();
    return new Promise((resolve) => {
      this.barrierWaiters.push(resolve);
      setTimeout(() => this.checkBarrier(), Math.max(0, ENV_BARRIER_MS - (Date.now() - this.startedAt)) + 5);
    });
  }

  // ── views (docs/plan/07-plugin-engine.md §7.5) ──

  private hasBackend(pluginId: string): boolean {
    return !!this.deps.plugins.get(pluginId)?.manifest?.main;
  }

  private async openInHost(req: OpenViewRequest): Promise<void> {
    if (!this.hasBackend(req.pluginId) || this.deps.host.state !== 'running') return;
    await this.activateByEvent(`${req.kind === 'view' ? 'onView' : 'onPanel'}:${req.providerId}`);
    try {
      await this.deps.host.call('views:open', req);
    } catch (e) {
      this.deps.logger.warn(`Opening view ${req.providerId} failed`, e);
    }
  }

  async viewOpened(req: OpenViewRequest): Promise<void> {
    const plugin = this.deps.plugins.get(req.pluginId);
    const m = plugin?.manifest;
    const declared =
      req.kind === 'view'
        ? m?.contributes.views.some((v) => v.id === req.providerId)
        : m?.contributes.panels.some((p) => p.type === req.providerId);
    if (!plugin || !declared) throw new OxyError('NOT_FOUND', `Unknown view ${req.pluginId}/${req.providerId}`);
    this.openViews.set(req.viewId, req);
    const ready = this.openInHost(req);
    this.viewReady.set(req.viewId, ready);
    await ready;
  }

  async viewClosed(viewId: string): Promise<void> {
    const req = this.openViews.get(viewId);
    this.openViews.delete(viewId);
    this.viewRates.delete(viewId);
    this.viewReady.delete(viewId);
    if (req && this.hasBackend(req.pluginId) && this.deps.host.state === 'running')
      await this.deps.host.call('views:close', { viewId }).catch(() => undefined);
  }

  async viewVisibility(viewId: string, visible: boolean): Promise<void> {
    const req = this.openViews.get(viewId);
    if (!req) return;
    req.visible = visible;
    if (this.hasBackend(req.pluginId) && this.deps.host.state === 'running')
      await this.deps.host.call('views:visibility', { viewId, visible }).catch(() => undefined);
  }

  /** View → backend; oversized or too frequent messages are rejected. */
  async viewMessage(viewId: string, envelope: ViewEnvelope): Promise<void> {
    const req = this.openViews.get(viewId);
    if (!req) throw new OxyError('NOT_FOUND', `View ${viewId} is not open`);
    if (JSON.stringify(envelope).length > MAX_VIEW_MESSAGE_BYTES)
      throw new OxyError('INVALID', 'View messages are limited to 1 MB');
    const now = Date.now();
    const rate = this.viewRates.get(viewId) ?? { windowStart: now, count: 0 };
    if (now - rate.windowStart >= 1000) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count++;
    this.viewRates.set(viewId, rate);
    if (rate.count > MAX_VIEW_MESSAGES_PER_SECOND) throw new OxyError('INVALID', 'Too many view messages (200/s)');
    if (!this.hasBackend(req.pluginId)) {
      if (envelope.kind === 'req')
        this.deps.core.toRenderer('viewMessage', {
          viewId,
          envelope: { kind: 'res', id: envelope.id, ok: false, error: 'This plugin has no backend' },
        });
      return;
    }
    await this.viewReady.get(viewId);
    await this.deps.host.call('views:message', { viewId, envelope });
  }

  // ── events forwarded to the host ──

  private emitApi(name: string, payload: unknown): void {
    if (this.deps.host.state === 'running') this.deps.host.emit('api:event', { name, payload });
  }

  notifyProjects(projects: Project[]): void {
    this.emitApi('projects.changed', projects.map(toProjectInfo));
  }

  notifyActiveProject(id: string | null): void {
    const p = id ? this.deps.core.projects.get(id) : undefined;
    this.emitApi('projects.active', p ? toProjectInfo(p) : undefined);
    if (id) void this.activateByEvent('onProjectOpen');
  }

  notifyTerminal(info: TerminalInfo): void {
    const known = this.knownTerminals.has(info.id);
    this.knownTerminals.add(info.id);
    this.emitApi(known ? 'terminals.change' : 'terminals.open', toTerminalMeta(info));
  }

  notifyTerminalRemoved(id: string): void {
    this.knownTerminals.delete(id);
    this.emitApi('terminals.close', { id });
  }

  private seenAgents = new Set<string>();
  notifyAgents(list: AgentInfoWithTerminal[]): void {
    this.emitApi(
      'agents.changed',
      list.map((a) => this.agentSnapshot(a)),
    );
    for (const a of list) {
      if (this.seenAgents.has(a.agentId)) continue;
      this.seenAgents.add(a.agentId);
      void this.activateByEvent(`onAgentDetected:${a.agentId}`);
    }
  }

  notifyGitStatus(status: RepoStatus): void {
    this.emitApi('git.status', this.statusLite(status));
  }

  /** Settings as plugins see them: contributed defaults under the user's values. */
  private settingsWithDefaults(settings: Settings): Record<string, unknown> {
    return { ...configDefaults(collectContributions(this.deps.plugins.enabled())), ...settings };
  }

  notifySettings(settings: Settings): void {
    const next = this.settingsWithDefaults(settings);
    const keys = [...new Set([...Object.keys(next), ...Object.keys(this.lastSettings)])].filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(this.lastSettings[k]),
    );
    this.lastSettings = next;
    if (keys.length > 0) this.emitApi('settings.changed', { settings: next, keys });
  }

  private agentSnapshot(a: AgentInfoWithTerminal) {
    const t = this.deps.core.terminals.get(a.terminalId);
    return {
      terminalId: a.terminalId,
      projectId: a.projectId,
      agentId: a.agentId,
      displayName: a.displayName,
      provider: a.provider,
      pid: a.pid,
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      state: a.state,
      ...(a.waitingFor ? { waitingFor: a.waitingFor } : {}),
      since: a.since,
      ...(t ? { cwd: t.cwd } : {}),
    };
  }

  private statusLite(s: RepoStatus) {
    return {
      projectId: s.projectId,
      ...(s.branch?.head ? { branch: s.branch.head } : {}),
      files: s.files.map((f) => ({
        path: f.path,
        status: f.status,
        ...(f.additions !== undefined ? { additions: f.additions } : {}),
        ...(f.deletions !== undefined ? { deletions: f.deletions } : {}),
      })),
    };
  }

  // ── plugin UI state (rendered by the renderer, M5-T4) ──

  private clearPluginUi(pluginId: string): void {
    let changed = false;
    for (const [key, item] of [...this.statusBarItems]) {
      if (item.pluginId === pluginId) {
        this.statusBarItems.delete(key);
        changed = true;
      }
    }
    if (changed) this.statusEmitter.fire([...this.statusBarItems.values()]);
    this.setEnvironment(pluginId, null);
  }

  private setEnvironment(pluginId: string, contribution: EnvContribution | null): void {
    if (contribution) this.environments.set(pluginId, contribution);
    else if (!this.environments.delete(pluginId)) return;
    this.envEmitter.fire([...this.environments.values()]);
  }

  // ── API ──

  private permission(plugin: PluginDescriptor, permission: PluginPermission): void {
    if (!plugin.manifest?.permissions.includes(permission))
      throw new OxyError('PERMISSION', `Plugin ${plugin.id} needs the "${permission}" permission`);
  }

  private async apiCall({
    pluginId,
    method,
    params,
  }: {
    pluginId: string;
    method: string;
    params: unknown;
  }): Promise<unknown> {
    const core = this.deps.core;
    if (method === 'commands.executeCore') {
      const { id, args } = params as { id: string; args: unknown[] };
      if (!CORE_COMMANDS.has(id)) throw new OxyError('NOT_FOUND', `Unknown command: ${id}`);
      if (id === 'oxytocin.changes.refresh') return undefined;
      core.toRenderer('runCommand', { id, args });
      return undefined;
    }
    const plugin = this.deps.plugins.get(pluginId);
    if (!plugin || !plugin.manifest) throw new OxyError('NOT_FOUND', `Unknown plugin ${pluginId}`);
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'projects.list':
        this.permission(plugin, 'projects.read');
        return core.projects.list().map(toProjectInfo);
      case 'projects.getActive': {
        this.permission(plugin, 'projects.read');
        const id = core.projects.activeId();
        const project = id ? core.projects.get(id) : undefined;
        return project ? toProjectInfo(project) : null;
      }
      case 'projects.findByPath': {
        this.permission(plugin, 'projects.read');
        const project = core.projects.findByPath(String(p['path']));
        return project ? toProjectInfo(project) : null;
      }
      case 'terminals.list':
        this.permission(plugin, 'terminals.read-metadata');
        return core.terminals.list(typeof p['projectId'] === 'string' ? p['projectId'] : undefined).map(toTerminalMeta);
      case 'terminals.create': {
        this.permission(plugin, 'terminals.create');
        const info = await core.terminals.create({
          projectId: String(p['projectId']),
          ...(typeof p['profileId'] === 'string' ? { profileId: p['profileId'] } : {}),
          ...(typeof p['cwd'] === 'string' ? { cwd: p['cwd'] } : {}),
          ...(typeof p['title'] === 'string' ? { userTitle: p['title'] } : {}),
          ...(typeof p['command'] === 'string' ? { initialCommand: p['command'] } : {}),
        });
        core.toRenderer('openTerminalPanel', {
          terminalId: info.id,
          projectId: info.projectId,
          placement: p['placement'] ?? 'active-group',
        });
        return toTerminalMeta(info);
      }
      case 'terminals.sendText': {
        this.permission(plugin, 'terminals.write');
        const id = String(p['id']);
        if (!core.terminals.get(id)) throw new OxyError('NOT_FOUND', `Terminal ${id} not found`);
        await core.terminals.write(id, `${String(p['text'])}${p['addNewLine'] === false ? '' : '\r'}`);
        return undefined;
      }
      case 'terminals.environment': {
        this.permission(plugin, 'terminals.env');
        const { entries, description } = p as unknown as Omit<EnvContribution, 'pluginId'>;
        this.setEnvironment(pluginId, {
          pluginId,
          entries: Array.isArray(entries) ? entries : [],
          ...(description ? { description } : {}),
        });
        return undefined;
      }
      case 'terminals.environmentReady':
        this.permission(plugin, 'terminals.env');
        this.envReady.add(pluginId);
        this.checkBarrier();
        return undefined;
      case 'agents.list':
        this.permission(plugin, 'agents.read');
        return core.agents.list().map((a) => this.agentSnapshot(a));
      case 'agents.reportSession':
        this.permission(plugin, 'agents.annotate');
        core.agents.reportSession(String(p['terminalId']), String(p['sessionId']));
        return undefined;
      case 'git.getStatus': {
        this.permission(plugin, 'git.read');
        const status = core.git.status(String(p['projectId']));
        return status && status.state === 'ok' ? this.statusLite(status) : null;
      }
      case 'ui.showNotification': {
        const level = p['level'] === 'error' ? 'error' : p['level'] === 'warning' ? 'warning' : 'info';
        const message = typeof p['message'] === 'string' ? p['message'] : '';
        core.toRenderer('toast', {
          kind: level,
          message,
          ...(typeof p['detail'] === 'string' ? { description: p['detail'] } : {}),
        });
        if (p['os'] === true) {
          this.permission(plugin, 'notifications.os');
          const s = core.settings();
          if (s['notifications.os'] && !s['notifications.doNotDisturb']) core.osNotify(plugin.displayName, message);
        }
        return null;
      }
      case 'ui.openExternal': {
        const url = String(p['url']);
        if (!/^https?:\/\//i.test(url)) throw new OxyError('PERMISSION', 'Only http and https links can be opened');
        await core.openExternal(url);
        return undefined;
      }
      case 'ui.openInEditor':
        await core.openInEditor({
          path: String(p['path']),
          ...(typeof p['line'] === 'number' ? { line: p['line'] } : {}),
          ...(typeof p['column'] === 'number' ? { column: p['column'] } : {}),
        });
        return undefined;
      case 'ui.statusBarItem': {
        const id = String(p['id']);
        if (!plugin.manifest.contributes.statusBarItems.some((s) => s.id === id))
          throw new OxyError('INVALID', `Status bar item ${id} is not declared`);
        const item: StatusBarItemState = {
          pluginId,
          id,
          text: typeof p['text'] === 'string' ? p['text'] : '',
          ...(typeof p['tooltip'] === 'string' ? { tooltip: p['tooltip'] } : {}),
          ...(typeof p['color'] === 'string' ? { color: p['color'] as StatusBarItemState['color'] } : {}),
          ...(p['command'] ? { command: p['command'] as StatusBarItemState['command'] } : {}),
          visible: p['visible'] === true,
        };
        this.statusBarItems.set(`${pluginId}:${id}`, item);
        this.statusEmitter.fire([...this.statusBarItems.values()]);
        return undefined;
      }
      case 'ui.openPanel': {
        const panelType = String(p['panelType']);
        if (!plugin.manifest.contributes.panels.some((x) => x.type === panelType))
          throw new OxyError('INVALID', `Panel type ${panelType} is not declared by ${pluginId}`);
        core.toRenderer('openPanel', {
          panelType,
          ...(typeof p['projectId'] === 'string' ? { projectId: p['projectId'] } : {}),
          ...(p['params'] !== undefined ? { params: p['params'] } : {}),
          ...(typeof p['title'] === 'string' ? { title: p['title'] } : {}),
          ...(typeof p['placement'] === 'string' ? { placement: p['placement'] } : {}),
        });
        return undefined;
      }
      case 'settings.update': {
        const key = String(p['key']);
        const prefix = plugin.manifest.contributes.configuration?.prefix;
        if (!prefix || !key.startsWith(`${prefix}.`))
          throw new OxyError('PERMISSION', `Plugin ${pluginId} can only change its own settings`);
        const prop = plugin.manifest.contributes.configuration?.properties[key];
        if (!prop) throw new OxyError('INVALID', `Setting ${key} is not declared in contributes.configuration`);
        const problem = validateConfigValue(key, prop, p['value']);
        if (problem) throw new OxyError('INVALID', problem);
        await core.updateSettings({ [key]: p['value'] });
        return undefined;
      }
      default:
        throw new OxyError('NOT_FOUND', `Unknown API method ${method}`);
    }
  }

  dispose(): void {
    this.store.dispose();
    this.statusEmitter.dispose();
    this.envEmitter.dispose();
  }
}
