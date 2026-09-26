import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginView, ViewProvider } from '@oxytocin/plugin-api';
import type { ViewEnvelope } from '@shared/rpc/contracts/plugin-host';
import { Emitter } from '@shared/utils/emitter';
import { ViewHost } from './views';

afterEach(() => vi.useRealTimers());

function setup(providers: Record<string, ViewProvider> = {}) {
  const sent: { viewId: string; envelope: ViewEnvelope }[] = [];
  const metas: unknown[] = [];
  const registered = new Emitter<string>();
  const errors: string[] = [];
  const host = new ViewHost({
    send: (viewId, envelope) => sent.push({ viewId, envelope }),
    meta: (viewId, meta) => metas.push({ viewId, ...meta }),
    provider: (id) => (providers[id] ? { pluginId: 'p', provider: providers[id] } : undefined),
    onProvider: registered.event,
    error: (_p, where, e) => errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`),
  });
  const req = { viewId: 'v1', pluginId: 'p', kind: 'panel' as const, providerId: 'x', visible: true, params: { a: 1 } };
  return { host, sent, metas, registered, errors, req, providers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ViewHost', () => {
  it('resolves views with their provider and routes messages, requests and visibility', async () => {
    let view: PluginView | undefined;
    const received: unknown[] = [];
    const visibility: boolean[] = [];
    const s = setup({
      x: {
        resolve(v) {
          view = v;
          v.onDidReceiveMessage((m) => received.push(m));
          v.onDidChangeVisibility((vis) => visibility.push(vis));
          v.onRequest('double', (n: number) => n * 2);
          v.onRequest('boom', () => {
            throw new Error('bad');
          });
          v.title = 'T';
        },
      },
    });
    s.host.open(s.req);
    await flush();
    expect(view).toMatchObject({ id: 'v1', kind: 'panel', params: { a: 1 }, visible: true });
    expect(s.metas).toEqual([{ viewId: 'v1', title: 'T' }]);
    expect(s.sent).toContainEqual({ viewId: 'v1', envelope: { kind: 'evt', name: 'resolved', payload: null } });

    await s.host.message('v1', { kind: 'msg', payload: 'hi' });
    await s.host.message('v1', { kind: 'req', id: 1, method: 'double', payload: 21 });
    await s.host.message('v1', { kind: 'req', id: 2, method: 'boom', payload: null });
    await s.host.message('v1', { kind: 'req', id: 3, method: 'missing', payload: null });
    expect(received).toEqual(['hi']);
    expect(s.sent.map((x) => x.envelope)).toEqual(
      expect.arrayContaining([
        { kind: 'res', id: 1, ok: true, result: 42 },
        { kind: 'res', id: 2, ok: false, error: 'bad' },
        { kind: 'res', id: 3, ok: false, error: 'No handler for "missing"' },
      ]),
    );
    s.host.setVisible('v1', false);
    expect(visibility).toEqual([false]);
    expect(await view!.postMessage('to view')).toBe(true);
    s.host.close('v1');
    expect(await view!.postMessage('late')).toBe(false);
  });

  it('waits for a provider registered later and reports a missing one after 10 s', async () => {
    vi.useFakeTimers();
    const resolved = vi.fn();
    const s = setup();
    s.host.open(s.req);
    s.providers['x'] = { resolve: resolved };
    s.registered.fire('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledTimes(1);

    s.host.open({ ...s.req, viewId: 'v2', providerId: 'never' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.sent.at(-1)).toMatchObject({ viewId: 'v2', envelope: { kind: 'evt', name: 'error' } });
  });

  it('reports errors thrown by resolve() to the view', async () => {
    const s = setup({
      x: {
        resolve() {
          throw new Error('cannot render');
        },
      },
    });
    s.host.open(s.req);
    await flush();
    await flush();
    expect(s.errors).toEqual(['resolve(): cannot render']);
    expect(s.sent.at(-1)?.envelope).toEqual({ kind: 'evt', name: 'error', payload: { message: 'cannot render' } });
  });
});
