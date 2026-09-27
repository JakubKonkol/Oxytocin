import type {
  AgentSnapshot,
  CommandsApi,
  Disposable,
  EnvironmentCollection,
  EnvScope,
  Event,
  OxytocinApi,
  PluginView,
  ProjectInfo,
  RepoStatusLite,
  StatusBarItem,
  TerminalMeta,
  ViewProvider,
} from '@oxytocin/plugin-api';
import { OXYTOCIN_API_VERSION } from '@shared/constants';
import { OxyError } from '@shared/errors';
import type { HostApiEnv, HostPluginInfo } from '@shared/rpc/contracts/plugin-host';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';

export type ApiEventName =
  | 'projects.changed'
  | 'projects.active'
  | 'terminals.open'
  | 'terminals.change'
  | 'terminals.close'
  | 'agents.changed'
  | 'git.status'
  | 'settings.changed';

/** Events from main, fanned out to plugin listeners. */
export class ApiEvents {
  private readonly emitters = new Map<ApiEventName, Emitter<unknown>>();

  emitter(name: ApiEventName): Emitter<unknown> {
    let e = this.emitters.get(name);
    if (!e) {
      e = new Emitter<unknown>();
      this.emitters.set(name, e);
    }
    return e;
  }

  fire(name: ApiEventName, payload: unknown): void {
    this.emitters.get(name)?.fire(payload);
  }
}

export interface EnvEntry {
  op: 'replace' | 'append' | 'prepend' | 'delete';
  name: string;
  value?: string;
  scope?: EnvScope;
  separator?: string;
}

export interface ApiDeps {
  plugin: HostPluginInfo;
  env: HostApiEnv;
  events: ApiEvents;
  /** RPC to main (`api:call`). */
  call: (method: string, params: unknown) => Promise<unknown>;
  settings: () => Record<string, unknown>;
  /** Registers a disposable that is disposed on deactivation. */
  track: (d: Disposable) => Disposable;
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => Disposable;
  executeCommand: (id: string, args: unknown[]) => Promise<unknown>;
  registerProvider: (kind: 'view' | 'panel', id: string, provider: ViewProvider) => Disposable;
  /** Reports an error thrown by plugin code inside a callback. */
  reportError: (where: string, error: unknown) => void;
}

const PUBLIC_CORE_PREFIXES = ['appearance.'];

/** One API object per plugin; permission-guarded methods throw `PERMISSION` errors (07 §6.3). */
export function createApi(deps: ApiDeps): OxytocinApi {
  const { plugin } = deps;
  const has = (permission: string) => plugin.permissions.includes(permission);
  const require = (permission: string) => {
    if (!has(permission))
      throw new OxyError(
        'PERMISSION',
        `Plugin ${plugin.id} needs the "${permission}" permission (add it to the manifest)`,
      );
  };
  const call = <T>(method: string, params: unknown = null) => deps.call(method, params) as Promise<T>;
  const event =
    <T>(name: ApiEventName, permission?: string): Event<T> =>
    (listener) => {
      if (permission) require(permission);
      const d = deps.events.emitter(name).event((payload) => {
        try {
          const r = listener(payload as T);
          if (r instanceof Promise) r.catch((e: unknown) => deps.reportError(`${name} listener`, e));
        } catch (e) {
          deps.reportError(`${name} listener`, e);
        }
      });
      return deps.track(d);
    };

  // ── environment collection (synchronised to main, debounced 50 ms) ──
  let envEntries: EnvEntry[] = [];
  let envTimer: ReturnType<typeof setTimeout> | undefined;
  let envDescription: string | undefined;
  const syncEnv = () => {
    if (envTimer) clearTimeout(envTimer);
    envTimer = setTimeout(() => {
      envTimer = undefined;
      void call('terminals.environment', { entries: envEntries, description: envDescription }).catch((e: unknown) =>
        deps.reportError('environment', e),
      );
    }, 50);
  };
  const envOp = (op: EnvEntry['op'], name: string, value?: string, scope?: EnvScope, separator?: string) => {
    require('terminals.env');
    const key = JSON.stringify(scope ?? {});
    envEntries = envEntries.filter((e) => !(e.name === name && JSON.stringify(e.scope ?? {}) === key));
    envEntries.push({
      op,
      name,
      ...(value !== undefined ? { value } : {}),
      ...(scope ? { scope } : {}),
      ...(separator ? { separator } : {}),
    });
    syncEnv();
  };
  const environment: EnvironmentCollection = {
    replace: (n, v, s) => envOp('replace', n, v, s),
    append: (n, v, s, o) => envOp('append', n, v, s, o?.separator),
    prepend: (n, v, s, o) => envOp('prepend', n, v, s, o?.separator),
    delete: (n, s) => envOp('delete', n, undefined, s),
    clear: () => {
      require('terminals.env');
      envEntries = [];
      syncEnv();
    },
    ready: () => {
      require('terminals.env');
      void call('terminals.environmentReady').catch(() => undefined);
    },
    get description() {
      return envDescription;
    },
    set description(value: string | undefined) {
      envDescription = value;
      syncEnv();
    },
  };

  const statusItems = new Map<string, StatusBarItem>();
  const commands: CommandsApi = {
    register: (id, handler) => deps.registerCommand(id, handler),
    execute: <T>(id: string, ...args: unknown[]) => deps.executeCommand(id, args) as Promise<T>,
  };

  const ownPrefix = plugin.configurationPrefix ? `${plugin.configurationPrefix}.` : null;
  const readable = (key: string) =>
    (ownPrefix !== null && key.startsWith(ownPrefix)) || PUBLIC_CORE_PREFIXES.some((p) => key.startsWith(p));

  return {
    version: OXYTOCIN_API_VERSION,
    env: { ...deps.env },
    projects: {
      list: async () => {
        require('projects.read');
        return call<ProjectInfo[]>('projects.list');
      },
      getActive: async () => {
        require('projects.read');
        return (await call<ProjectInfo | null>('projects.getActive')) ?? undefined;
      },
      findByPath: async (path) => {
        require('projects.read');
        return (await call<ProjectInfo | null>('projects.findByPath', { path })) ?? undefined;
      },
      onDidChangeActive: event<ProjectInfo | undefined>('projects.active', 'projects.read'),
      onDidChange: event<ProjectInfo[]>('projects.changed', 'projects.read'),
    },
    terminals: {
      list: async (filter) => {
        require('terminals.read-metadata');
        return call<TerminalMeta[]>('terminals.list', filter ?? {});
      },
      onDidOpen: event<TerminalMeta>('terminals.open', 'terminals.read-metadata'),
      onDidClose: event<{ id: string }>('terminals.close', 'terminals.read-metadata'),
      onDidChange: event<TerminalMeta>('terminals.change', 'terminals.read-metadata'),
      create: async (o) => {
        require('terminals.create');
        return call<TerminalMeta>('terminals.create', o);
      },
      sendText: async (id, text, opts) => {
        require('terminals.write');
        await call('terminals.sendText', { id, text, addNewLine: opts?.addNewLine ?? true });
      },
      environment,
    },
    agents: {
      list: async () => {
        require('agents.read');
        return call<AgentSnapshot[]>('agents.list');
      },
      onDidChange: event<AgentSnapshot[]>('agents.changed', 'agents.read'),
      reportSession: (terminalId, info) => {
        require('agents.annotate');
        void call('agents.reportSession', { terminalId, ...info }).catch((e: unknown) =>
          deps.reportError('reportSession', e),
        );
      },
    },
    git: {
      getStatus: async (projectId) => {
        require('git.read');
        return (await call<RepoStatusLite | null>('git.getStatus', { projectId })) ?? undefined;
      },
      onDidChangeStatus: event<RepoStatusLite>('git.status', 'git.read'),
    },
    ui: {
      registerViewProvider: (viewId, provider) => {
        if (!plugin.views.includes(viewId))
          throw new OxyError('INVALID', `View "${viewId}" is not declared in contributes.views`);
        return deps.registerProvider('view', viewId, provider);
      },
      registerPanelProvider: (panelType, provider) => {
        if (!plugin.panels.includes(panelType))
          throw new OxyError('INVALID', `Panel type "${panelType}" is not declared in contributes.panels`);
        return deps.registerProvider('panel', panelType, provider);
      },
      openPanel: async (panelType, o) => {
        await call('ui.openPanel', { panelType, ...(o ?? {}) });
      },
      statusBarItem: (id) => {
        if (!plugin.statusBarItems.includes(id))
          throw new OxyError('INVALID', `Status bar item "${id}" is not declared in contributes.statusBarItems`);
        const existing = statusItems.get(id);
        if (existing) return existing;
        const state: {
          text: string;
          tooltip?: string;
          color?: StatusBarItem['color'];
          command?: StatusBarItem['command'];
          visible: boolean;
        } = {
          text: '',
          visible: false,
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const push = () => {
          if (timer) return;
          timer = setTimeout(() => {
            timer = undefined;
            void call('ui.statusBarItem', { id, ...state }).catch((e: unknown) => deps.reportError('statusBarItem', e));
          }, 16);
        };
        const item: StatusBarItem = {
          get text() {
            return state.text;
          },
          set text(v) {
            state.text = v;
            push();
          },
          get tooltip() {
            return state.tooltip;
          },
          set tooltip(v) {
            state.tooltip = v;
            push();
          },
          get color() {
            return state.color;
          },
          set color(v) {
            state.color = v;
            push();
          },
          get command() {
            return state.command;
          },
          set command(v) {
            state.command = v;
            push();
          },
          show: () => {
            state.visible = true;
            push();
          },
          hide: () => {
            state.visible = false;
            push();
          },
          dispose: () => {
            state.visible = false;
            statusItems.delete(id);
            push();
          },
        };
        statusItems.set(id, item);
        deps.track(toDisposable(() => item.dispose()));
        return item;
      },
      showNotification: async (o) => {
        if (o.os) require('notifications.os');
        return (await call<string | null>('ui.showNotification', o)) ?? undefined;
      },
      openExternal: async (url) => {
        await call('ui.openExternal', { url });
      },
      openInEditor: async (path, line, column) => {
        await call('ui.openInEditor', { path, ...(line ? { line } : {}), ...(column ? { column } : {}) });
      },
      showQuickPick: async (items, options) => {
        const index = await call<number | null>('ui.showQuickPick', {
          items: items.map((i) => ({
            label: String(i.label),
            ...(i.description !== undefined ? { description: String(i.description) } : {}),
            ...(i.detail !== undefined ? { detail: String(i.detail) } : {}),
          })),
          ...(options?.placeholder ? { placeholder: options.placeholder } : {}),
        });
        return typeof index === 'number' ? items[index] : undefined;
      },
    },
    commands,
    settings: {
      get: <T>(key: string): T => {
        if (!readable(key)) throw new OxyError('PERMISSION', `Plugin ${plugin.id} cannot read the setting "${key}"`);
        return deps.settings()[key] as T;
      },
      update: async (key, value) => {
        if (ownPrefix === null || !key.startsWith(ownPrefix))
          throw new OxyError(
            'PERMISSION',
            `Plugin ${plugin.id} can only change settings starting with "${ownPrefix ?? '<prefix>'}"`,
          );
        await call('settings.update', { key, value });
      },
      onDidChange: (keyPrefix, listener) =>
        event<string[]>('settings.changed')((keys) => {
          if (keys.some((k) => k.startsWith(keyPrefix))) listener();
        }),
    },
  };
}

export type { PluginView };
