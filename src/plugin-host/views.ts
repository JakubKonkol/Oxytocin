import type { Disposable, PluginView, ViewProvider } from '@oxytocin/plugin-api';
import type { OpenViewRequest, ViewEnvelope } from '@shared/rpc/contracts/plugin-host';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';

const PROVIDER_WAIT_MS = 10_000;

export interface ViewHostBridge {
  send(viewId: string, envelope: ViewEnvelope): void;
  meta(viewId: string, meta: { title?: string; badge?: PluginView['badge'] | null }): void;
  /** Provider registered for `providerId` (after activation), if any. */
  provider(providerId: string): { pluginId: string; provider: ViewProvider } | undefined;
  /** Resolves when a provider for the id is registered. */
  onProvider(listener: (providerId: string) => void): Disposable;
  error(pluginId: string, where: string, error: unknown): void;
}

interface ViewInstance {
  req: OpenViewRequest;
  view: PluginView;
  visible: boolean;
  messages: Emitter<unknown>;
  visibility: Emitter<boolean>;
  disposed: Emitter<void>;
  handlers: Map<string, (params: unknown) => unknown>;
  pending: Disposable | undefined;
}

/** View instances in the Plugin Host (`PluginView` objects handed to providers, docs/plan/07 §6.4). */
export class ViewHost {
  private readonly views = new Map<string, ViewInstance>();

  constructor(private readonly bridge: ViewHostBridge) {}

  open(req: OpenViewRequest): void {
    this.close(req.viewId);
    const messages = new Emitter<unknown>();
    const visibility = new Emitter<boolean>();
    const disposed = new Emitter<void>();
    const handlers = new Map<string, (params: unknown) => unknown>();
    let title: string | undefined;
    let badge: PluginView['badge'];
    const instance: ViewInstance = {
      req,
      visible: req.visible,
      messages,
      visibility,
      disposed,
      handlers,
      pending: undefined,
      view: undefined as unknown as PluginView,
    };
    const guard =
      <T>(where: string, fn: (v: T) => unknown) =>
      (v: T) => {
        try {
          const r = fn(v);
          if (r instanceof Promise) r.catch((e: unknown) => this.bridge.error(req.pluginId, where, e));
        } catch (e) {
          this.bridge.error(req.pluginId, where, e);
        }
      };
    const bridge = this.bridge;
    instance.view = {
      id: req.viewId,
      kind: req.kind,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      ...(req.params !== undefined ? { params: req.params } : {}),
      get title() {
        return title;
      },
      set title(value) {
        title = value;
        bridge.meta(req.viewId, value === undefined ? {} : { title: value });
      },
      get badge() {
        return badge;
      },
      set badge(value) {
        badge = value;
        bridge.meta(req.viewId, { badge: value ?? null });
      },
      get visible() {
        return instance.visible;
      },
      postMessage: (msg) => {
        if (!this.views.has(req.viewId)) return Promise.resolve(false);
        bridge.send(req.viewId, { kind: 'msg', payload: msg });
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener) => messages.event(guard('onDidReceiveMessage', listener)),
      onRequest: <P, R>(method: string, handler: (params: P) => R | Promise<R>) => {
        handlers.set(method, handler as (params: unknown) => unknown);
        return toDisposable(() => {
          if (handlers.get(method) === handler) handlers.delete(method);
        });
      },
      onDidChangeVisibility: (listener) => visibility.event(guard('onDidChangeVisibility', listener)),
      onDidDispose: (listener) => disposed.event(guard('onDidDispose', listener)),
    };
    this.views.set(req.viewId, instance);
    this.resolve(instance);
  }

  private resolve(instance: ViewInstance): void {
    const found = this.bridge.provider(instance.req.providerId);
    if (found) {
      void Promise.resolve()
        .then(() => found.provider.resolve(instance.view))
        .then(
          () => this.bridge.send(instance.req.viewId, { kind: 'evt', name: 'resolved', payload: null }),
          (e: unknown) => {
            this.bridge.error(instance.req.pluginId, 'resolve()', e);
            this.bridge.send(instance.req.viewId, {
              kind: 'evt',
              name: 'error',
              payload: { message: e instanceof Error ? e.message : String(e) },
            });
          },
        );
      return;
    }
    // Wait for the plugin to register its provider (activation in progress).
    const timer = setTimeout(() => {
      instance.pending?.dispose();
      instance.pending = undefined;
      this.bridge.send(instance.req.viewId, {
        kind: 'evt',
        name: 'error',
        payload: { message: `The plugin did not provide the view "${instance.req.providerId}"` },
      });
    }, PROVIDER_WAIT_MS);
    const sub = this.bridge.onProvider((id) => {
      if (id !== instance.req.providerId) return;
      clearTimeout(timer);
      instance.pending?.dispose();
      instance.pending = undefined;
      this.resolve(instance);
    });
    instance.pending = toDisposable(() => {
      clearTimeout(timer);
      sub.dispose();
    });
  }

  close(viewId: string): void {
    const instance = this.views.get(viewId);
    if (!instance) return;
    this.views.delete(viewId);
    instance.pending?.dispose();
    instance.disposed.fire();
    instance.messages.dispose();
    instance.visibility.dispose();
    instance.disposed.dispose();
  }

  /** Views of a plugin being deactivated. */
  closeForPlugin(pluginId: string): void {
    for (const [id, v] of [...this.views]) if (v.req.pluginId === pluginId) this.close(id);
  }

  setVisible(viewId: string, visible: boolean): void {
    const instance = this.views.get(viewId);
    if (!instance || instance.visible === visible) return;
    instance.visible = visible;
    instance.visibility.fire(visible);
  }

  async message(viewId: string, envelope: ViewEnvelope): Promise<void> {
    const instance = this.views.get(viewId);
    if (!instance) return;
    if (envelope.kind === 'msg') {
      instance.messages.fire(envelope.payload);
      return;
    }
    if (envelope.kind !== 'req') return;
    const handler = instance.handlers.get(envelope.method);
    if (!handler) {
      this.bridge.send(viewId, {
        kind: 'res',
        id: envelope.id,
        ok: false,
        error: `No handler for "${envelope.method}"`,
      });
      return;
    }
    try {
      const result = await handler(envelope.payload);
      this.bridge.send(viewId, { kind: 'res', id: envelope.id, ok: true, result });
    } catch (e) {
      this.bridge.error(instance.req.pluginId, `request ${envelope.method}`, e);
      this.bridge.send(viewId, {
        kind: 'res',
        id: envelope.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Re-resolves open views of a plugin after it was (re)activated. */
  reopenForPlugin(pluginId: string): void {
    for (const v of [...this.views.values()]) if (v.req.pluginId === pluginId) this.open(v.req);
  }
}
