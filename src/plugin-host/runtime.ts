import { pathToFileURL } from 'node:url';
import type { Disposable, Logger, PluginContext, PluginModule, ViewProvider } from '@oxytocin/plugin-api';
import { OxyError } from '@shared/errors';
import type { HostApiEnv, HostPluginInfo, PluginLogEntry } from '@shared/rpc/contracts/plugin-host';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { ApiEvents, type ApiEventName, createApi } from './api';
import { createPluginStorage } from './storage';

const ACTIVATE_WARN_MS = 5000;
const DEACTIVATE_TIMEOUT_MS = 2000;
const LOG_LIMIT = 500;

export interface RuntimeBridge {
  /** `api:call` to main on behalf of a plugin. */
  call(pluginId: string, method: string, params: unknown): Promise<unknown>;
  state(id: string, state: 'active' | 'failed' | 'inactive', error?: string): void;
  busy(id: string | null): void;
  log(pluginId: string, level: PluginLogEntry['level'], message: string): void;
}

interface LoadedPlugin {
  info: HostPluginInfo;
  state: 'inactive' | 'activating' | 'active' | 'failed';
  activation?: Promise<void>;
  module?: PluginModule;
  context?: PluginContext;
  /** Internal disposables (event subscriptions, commands, providers) besides ctx.subscriptions. */
  internal: Disposable[];
  logs: PluginLogEntry[];
  /** Reload counter used for cache-busting imports. */
  generation: number;
}

const errorText = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** Loads, activates and isolates plugin backends inside the Plugin Host. */
export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly commands = new Map<string, { pluginId: string; handler: (...args: unknown[]) => unknown }>();
  readonly providers = new Map<string, { pluginId: string; kind: 'view' | 'panel'; provider: ViewProvider }>();
  readonly events = new ApiEvents();
  private readonly providerEmitter = new Emitter<string>();
  /** A view/panel provider was registered (views waiting for it resolve now). */
  readonly onDidRegisterProvider = this.providerEmitter.event;
  private readonly deactivateEmitter = new Emitter<string>();
  readonly onDidDeactivate = this.deactivateEmitter.event;
  private settingsSnapshot: Record<string, unknown> = {};
  private env: HostApiEnv = { appVersion: '0.0.0', platform: 'linux', locale: 'en-US', homeDir: '', userDataDir: '' };
  private generationCounter = 0;

  constructor(
    private readonly bridge: RuntimeBridge,
    private readonly importModule: (url: string) => Promise<unknown> = (url) => import(url),
  ) {}

  get(id: string): LoadedPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Replaces the plugin list: removed or changed plugins are deactivated first. */
  async load(list: HostPluginInfo[], settings: Record<string, unknown>, env: HostApiEnv): Promise<void> {
    this.settingsSnapshot = settings;
    this.env = env;
    const next = new Map(list.map((p) => [p.id, p]));
    for (const [id, loaded] of [...this.plugins]) {
      const replacement = next.get(id);
      if (!replacement || JSON.stringify(replacement) !== JSON.stringify(loaded.info)) {
        await this.deactivate(id);
        this.plugins.delete(id);
      }
    }
    for (const info of list) {
      if (this.plugins.has(info.id)) continue;
      this.plugins.set(info.id, {
        info,
        state: 'inactive',
        internal: [],
        logs: [],
        generation: ++this.generationCounter,
      });
    }
  }

  updateSettings(settings: Record<string, unknown>, changedKeys: string[]): void {
    this.settingsSnapshot = settings;
    this.events.fire('settings.changed', changedKeys);
  }

  dispatch(name: string, payload: unknown): void {
    if (name === 'settings.changed') {
      const { settings, keys } = payload as { settings: Record<string, unknown>; keys: string[] };
      this.updateSettings(settings, keys);
      return;
    }
    this.events.fire(name as ApiEventName, payload);
  }

  /** Activates plugins whose activation events match (`*` matches everything). */
  async activateByEvent(event: string): Promise<string[]> {
    const matching = [...this.plugins.values()].filter(
      (p) =>
        p.state === 'inactive' && (p.info.activationEvents.includes(event) || p.info.activationEvents.includes('*')),
    );
    // One failing plugin must not affect the others (its state is reported as failed).
    await Promise.allSettled(matching.map((p) => this.activate(p.info.id, event)));
    return matching.map((p) => p.info.id);
  }

  private logger(plugin: LoadedPlugin): Logger {
    const write = (level: PluginLogEntry['level'], message: string, extra?: unknown) => {
      const text =
        extra === undefined ? message : `${message} ${extra instanceof Error ? errorText(extra) : safeJson(extra)}`;
      plugin.logs.push({ at: Date.now(), level, message: text });
      if (plugin.logs.length > LOG_LIMIT) plugin.logs.splice(0, plugin.logs.length - LOG_LIMIT);
      this.bridge.log(plugin.info.id, level, text);
    };
    return {
      debug: (m, meta) => write('debug', m, meta),
      info: (m, meta) => write('info', m, meta),
      warn: (m, meta) => write('warn', m, meta),
      error: (m, err) => write('error', m, err),
    };
  }

  logs(id: string): PluginLogEntry[] {
    return [...(this.plugins.get(id)?.logs ?? [])];
  }

  async activate(id: string, reason: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new OxyError('NOT_FOUND', `Plugin ${id} is not loaded`);
    if (plugin.state === 'active') return;
    if (plugin.state === 'failed') throw new OxyError('UNAVAILABLE', `Plugin ${id} failed to activate`);
    if (plugin.activation) return plugin.activation;
    plugin.state = 'activating';
    plugin.activation = this.doActivate(plugin, reason).finally(() => {
      plugin.activation = undefined;
    });
    return plugin.activation;
  }

  private async doActivate(plugin: LoadedPlugin, reason: string): Promise<void> {
    const { info } = plugin;
    const log = this.logger(plugin);
    const storage = createPluginStorage(this.env.userDataDir, info.id);
    const context: PluginContext = {
      plugin: { id: info.id, version: info.version, path: info.path, builtin: info.builtin },
      subscriptions: [],
      storage,
      log,
      oxy: createApi({
        plugin: info,
        env: this.env,
        events: this.events,
        call: (method, params) => this.bridge.call(info.id, method, params),
        settings: () => this.settingsSnapshot,
        track: (d) => {
          plugin.internal.push(d);
          return d;
        },
        registerCommand: (commandId, handler) => this.registerCommand(plugin, commandId, handler),
        executeCommand: (commandId, args) => this.executeCommand(commandId, args),
        registerProvider: (kind, providerId, provider) => this.registerProvider(plugin, kind, providerId, provider),
        reportError: (where, error) => log.error(`Error in ${where}`, error),
      }),
    };
    plugin.context = context;
    if (!info.main) {
      // View-only plugin: nothing to run.
      plugin.state = 'active';
      this.bridge.state(info.id, 'active');
      return;
    }
    const warn = setTimeout(
      () => log.warn(`activate() is taking more than ${ACTIVATE_WARN_MS / 1000} s`),
      ACTIVATE_WARN_MS,
    );
    this.bridge.busy(info.id);
    try {
      const url = `${pathToFileURL(info.main).href}?v=${plugin.generation}`;
      const mod = (await this.importModule(url)) as PluginModule & { default?: PluginModule };
      const module = typeof mod.activate === 'function' ? mod : mod.default;
      if (!module || typeof module.activate !== 'function') throw new Error('The backend does not export activate()');
      plugin.module = module;
      await module.activate(context);
      plugin.state = 'active';
      log.info(`Activated (${reason})`);
      this.bridge.state(info.id, 'active');
    } catch (e) {
      plugin.state = 'failed';
      log.error('activate() failed', e);
      this.disposeAll(plugin);
      this.bridge.state(info.id, 'failed', e instanceof Error ? e.message : String(e));
      throw new OxyError(
        'UNAVAILABLE',
        `Plugin ${info.id} failed to activate: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(warn);
      this.bridge.busy(null);
    }
  }

  private disposeAll(plugin: LoadedPlugin): void {
    const log = this.logger(plugin);
    for (const d of [...(plugin.context?.subscriptions ?? []), ...plugin.internal].reverse()) {
      try {
        d.dispose();
      } catch (e) {
        log.error('dispose() failed', e);
      }
    }
    if (plugin.context) plugin.context.subscriptions.length = 0;
    plugin.internal = [];
    for (const [id, c] of [...this.commands]) if (c.pluginId === plugin.info.id) this.commands.delete(id);
    for (const [id, p] of [...this.providers]) if (p.pluginId === plugin.info.id) this.providers.delete(id);
  }

  async deactivate(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.state === 'inactive') return;
    if (plugin.activation) await plugin.activation.catch(() => undefined);
    const wasFailed = plugin.state === 'failed';
    const log = this.logger(plugin);
    if (plugin.state === 'active' && plugin.module?.deactivate) {
      try {
        await Promise.race([
          Promise.resolve(plugin.module.deactivate()),
          new Promise((resolve) => setTimeout(resolve, DEACTIVATE_TIMEOUT_MS)),
        ]);
      } catch (e) {
        log.error('deactivate() failed', e);
      }
    }
    this.disposeAll(plugin);
    this.deactivateEmitter.fire(id);
    plugin.module = undefined;
    plugin.context = undefined;
    plugin.state = 'inactive';
    plugin.generation = ++this.generationCounter;
    // Unloading a failed plugin keeps its "failed" state visible in the plugin manager.
    if (!wasFailed) this.bridge.state(id, 'inactive');
  }

  /**
   * Reload: deactivate, then activate again (fresh `import()`) when it was active or activates at start-up;
   * a failed plugin gets another chance. Lazy plugins activate on their next event.
   */
  async reload(id: string): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    const wasActive = plugin.state === 'active' || plugin.state === 'activating';
    const wasFailed = plugin.state === 'failed';
    await this.deactivate(id);
    if (wasFailed) this.bridge.state(id, 'inactive');
    const { activationEvents } = plugin.info;
    if (wasActive || activationEvents.includes('*') || activationEvents.includes('onStartup'))
      await this.activate(id, 'reload').catch(() => undefined);
  }

  /** Marks a plugin failed after an uncaught error in its code and deactivates it. */
  async fail(id: string, error: unknown): Promise<void> {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    this.logger(plugin).error('Uncaught error', error);
    await this.deactivate(id);
    plugin.state = 'failed';
    this.bridge.state(id, 'failed', error instanceof Error ? error.message : String(error));
  }

  /** Writes to a plugin's log (errors in view callbacks). */
  logError(id: string, message: string, error: unknown): void {
    const plugin = this.plugins.get(id);
    if (plugin) this.logger(plugin).error(message, error);
  }

  /** Plugin whose folder appears in an error's stack (attributing uncaught errors). */
  pluginForError(error: unknown): string | undefined {
    const stack = error instanceof Error ? (error.stack ?? '') : String(error);
    const normalized = stack.split('\\').join('/');
    for (const p of this.plugins.values()) {
      const root = p.info.path.split('\\').join('/');
      if (normalized.includes(root) || normalized.includes(pathToFileURL(p.info.path).href)) return p.info.id;
    }
    return undefined;
  }

  private registerCommand(plugin: LoadedPlugin, id: string, handler: (...args: unknown[]) => unknown): Disposable {
    if (!plugin.info.commands.includes(id) && !id.startsWith(`${plugin.info.id}.`))
      throw new OxyError(
        'INVALID',
        `Command "${id}" must be declared in contributes.commands or start with "${plugin.info.id}."`,
      );
    const existing = this.commands.get(id);
    if (existing && existing.pluginId !== plugin.info.id)
      throw new OxyError('INVALID', `Command "${id}" is already registered by ${existing.pluginId}`);
    this.commands.set(id, { pluginId: plugin.info.id, handler });
    const d = toDisposable(() => {
      if (this.commands.get(id)?.handler === handler) this.commands.delete(id);
    });
    plugin.internal.push(d);
    return d;
  }

  private registerProvider(
    plugin: LoadedPlugin,
    kind: 'view' | 'panel',
    id: string,
    provider: ViewProvider,
  ): Disposable {
    this.providers.set(id, { pluginId: plugin.info.id, kind, provider });
    this.providerEmitter.fire(id);
    const d = toDisposable(() => {
      if (this.providers.get(id)?.provider === provider) this.providers.delete(id);
    });
    plugin.internal.push(d);
    return d;
  }

  /** Runs a plugin command, activating `onCommand:<id>` first; core commands go to main. */
  async executeCommand(id: string, args: unknown[]): Promise<unknown> {
    if (!this.commands.has(id)) {
      const owner = [...this.plugins.values()].find((p) => p.info.commands.includes(id));
      if (owner) {
        await this.activateByEvent(`onCommand:${id}`);
        if (owner.state === 'inactive') await this.activate(owner.info.id, `onCommand:${id}`);
      }
    }
    const command = this.commands.get(id);
    if (!command) {
      const owner = [...this.plugins.values()].find((p) => p.info.commands.includes(id));
      if (owner) throw new OxyError('UNAVAILABLE', `Command not available: ${id}`);
      // Not a plugin command: a core command, executed by main/renderer.
      return this.bridge.call('', 'commands.executeCore', { id, args });
    }
    this.bridge.busy(command.pluginId);
    try {
      return await command.handler(...args);
    } catch (e) {
      const owner = this.plugins.get(command.pluginId);
      if (owner) this.logger(owner).error(`Command ${id} failed`, e);
      throw e;
    } finally {
      this.bridge.busy(null);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.plugins.keys()].map((id) => this.deactivate(id)));
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
