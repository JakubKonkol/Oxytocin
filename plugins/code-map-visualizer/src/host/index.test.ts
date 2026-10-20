import { expect, it, vi } from 'vitest';
import type { PluginContext, PluginView, ViewProvider, CodeMapChange, Disposable } from '@oxytocin/plugin-api';
import { activate } from './index';

it('cancels hidden views and deduplicates reader audit invalidations without an update loop', async () => {
  let provider: ViewProvider | undefined,
    changed: ((change: CodeMapChange) => void) | undefined,
    visible: ((shown: boolean) => void) | undefined;
  const requests = new Map<string, (input: unknown) => unknown>(),
    post = vi.fn(() => Promise.resolve(true)),
    subscriptions: Disposable[] = [];
  let signal: AbortSignal | undefined;
  const disposable = { dispose() {} };
  const ctx = {
    subscriptions,
    oxy: {
      projects: { getActive: () => Promise.resolve({ id: 'p' }), onDidChangeActive: () => disposable },
      commands: { register: () => disposable },
      codeMap: {
        onDidChange: (listener: (c: CodeMapChange) => void) => {
          changed = listener;
          return disposable;
        },
        listCheckouts: () => Promise.resolve([{ projectId: 'p', checkoutId: 'p', mode: 'project' }]),
        query: (_request: unknown, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise((_, reject) =>
            signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          );
        },
      },
      ui: {
        registerPanelProvider: (_id: string, p: ViewProvider) => {
          provider = p;
          return disposable;
        },
      },
    },
  } as unknown as PluginContext;
  await activate(ctx);
  const view = {
    id: 'v',
    projectId: 'p',
    visible: true,
    postMessage: post,
    onRequest: (id: string, handler: (p: unknown) => unknown) => {
      requests.set(id, handler);
      return disposable;
    },
    onDidDispose: () => disposable,
    onDidChangeVisibility: (cb: (v: boolean) => void) => {
      visible = cb;
      return disposable;
    },
  } as unknown as PluginView;
  await provider!.resolve(view);
  const pending = Promise.resolve(requests.get('query')!({ view: 'overview' }));
  await vi.waitFor(() => expect(signal).toBeDefined());
  visible!(false);
  await expect(pending).rejects.toThrow('cancelled');
  vi.useFakeTimers();
  try {
    const event: CodeMapChange = { projectId: 'p', checkoutId: 'p', generation: 2, state: 'ready' };
    changed!(event);
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(1);
    changed!({ ...event, state: 'updating' });
    changed!(event);
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(1);
    changed!({ ...event, generation: 3 });
    await vi.advanceTimersByTimeAsync(160);
    expect(post).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    for (const subscription of subscriptions) subscription.dispose();
  }
});
