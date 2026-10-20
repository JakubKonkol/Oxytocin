import { describe, expect, it, vi } from 'vitest';
import { toDisposable } from '@shared/utils/disposable';
import type { HostPluginInfo } from '@shared/rpc/contracts/plugin-host';
import { ApiEvents, createApi } from './api';

const plugin: HostPluginInfo = {
  id: 'test.asker',
  version: '1.0.0',
  path: '/plugins/asker',
  builtin: false,
  permissions: [],
  activationEvents: [],
  commands: [],
  views: [],
  panels: [],
  statusBarItems: [],
  mcpTools: [],
};

function setup(
  answer: () => Promise<unknown>,
  options: { permissions?: string[]; call?: (method: string, params: unknown) => Promise<unknown> } = {},
) {
  const call = vi.fn((method: string, _params: unknown) =>
    options.call
      ? options.call(method, _params)
      : method === 'ui.showNotification'
        ? answer()
        : Promise.resolve(undefined),
  );
  const events = new ApiEvents();
  const api = createApi({
    plugin: { ...plugin, permissions: options.permissions ?? plugin.permissions },
    env: { appVersion: '0.7.1', platform: 'linux', locale: 'en-US', homeDir: '/home/u', userDataDir: '/data' },
    events,
    call,
    settings: () => ({}),
    track: (d) => d,
    registerCommand: () => toDisposable(() => undefined),
    executeCommand: () => Promise.resolve(undefined),
    registerProvider: () => toDisposable(() => undefined),
    registerMcpTool: () => toDisposable(() => undefined),
    reportError: () => undefined,
  });
  return { api, call, events };
}

const actions = [{ id: 'yes', title: 'Yes' }];

describe('Code Map API facade', () => {
  it('delivers only targeted, validated compact invalidations', () => {
    const s = setup(() => Promise.resolve(null), { permissions: ['code-map.read'] });
    const listener = vi.fn();
    s.api.codeMap.onDidChange(listener);
    const change = { projectId: 'p', checkoutId: 'p', generation: 3, state: 'ready' };
    s.events.fire('codeMap.changed', change, 'another.plugin');
    expect(listener).not.toHaveBeenCalled();
    s.events.fire('codeMap.changed', change, plugin.id);
    expect(listener).toHaveBeenCalledWith(change);
  });
  it('checks read permission before every operation and validates input/output', async () => {
    const denied = setup(() => Promise.resolve(null));
    await expect(denied.api.codeMap.listCheckouts('p')).rejects.toThrow('code-map.read');
    expect(() => denied.api.codeMap.onDidChange(() => {})).toThrow('code-map.read');
    await expect(
      denied.api.codeMap.openSource({
        projectId: 'p',
        checkoutId: 'p',
        path: 'a.ts',
        generation: 1,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('code-map.read');
    const allowed = setup(() => Promise.resolve(null), {
      permissions: ['code-map.read'],
      call: () => Promise.resolve([]),
    });
    expect(await allowed.api.codeMap.listCheckouts('p')).toEqual([]);
    await expect(
      allowed.api.codeMap.query({ projectId: 'p', checkoutId: 'p', kind: 'outline', path: '../secret' }),
    ).rejects.toThrow();
    await expect(
      allowed.api.codeMap.query({ projectId: 'p', checkoutId: 'p', kind: 'search', query: 'test' }),
    ).rejects.toThrow();
  });
  it('keeps AbortSignal in the facade and forwards cancellation with a private request id', async () => {
    let finish!: (v: unknown) => void;
    const s = setup(() => Promise.resolve(null), {
      permissions: ['code-map.read'],
      call: (method) =>
        method === 'codeMap.query'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(null),
    });
    const controller = new AbortController();
    const pending = s.api.codeMap.query(
      { projectId: 'p', checkoutId: 'p', kind: 'search', query: 'x' },
      { signal: controller.signal },
    );
    const input = s.call.mock.calls[0]![1] as { requestId: string };
    expect(input.requestId).toBeTruthy();
    controller.abort();
    expect(s.call).toHaveBeenLastCalledWith('codeMap.cancel', { requestId: input.requestId });
    finish(null);
    await expect(pending).rejects.toThrow();
  });
});

describe('ui.showNotification', () => {
  it('returns the clicked action', async () => {
    const s = setup(() => Promise.resolve('yes'));
    expect(await s.api.ui.showNotification({ level: 'info', message: 'Ask', actions })).toBe('yes');
    expect(s.call).toHaveBeenCalledWith('ui.showNotification', { level: 'info', message: 'Ask', actions });
  });

  it('withdraws a notification with a signal through a token', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    const s = setup(() => new Promise((r) => (resolve = r)));
    const controller = new AbortController();
    const shown = s.api.ui.showNotification({ level: 'warning', message: 'Ask', actions, signal: controller.signal });
    const params = s.call.mock.calls[0]![1] as { token: string; signal?: unknown };
    expect(params.token).toMatch(/^[\w-]{8,}$/);
    expect(params).not.toHaveProperty('signal');
    controller.abort();
    expect(s.call).toHaveBeenCalledWith('ui.dismissNotification', { token: params.token });
    resolve(null);
    expect(await shown).toBeUndefined();
  });

  it('does not show a notification whose signal is already aborted, nor send a token without buttons', async () => {
    const s = setup(() => Promise.resolve(null));
    expect(
      await s.api.ui.showNotification({ level: 'info', message: 'Late', actions, signal: AbortSignal.abort() }),
    ).toBeUndefined();
    expect(s.call).not.toHaveBeenCalled();
    await s.api.ui.showNotification({ level: 'info', message: 'Plain', signal: new AbortController().signal });
    expect(s.call).toHaveBeenCalledWith('ui.showNotification', { level: 'info', message: 'Plain' });
  });
});
