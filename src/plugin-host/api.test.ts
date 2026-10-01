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

function setup(answer: () => Promise<unknown>) {
  const call = vi.fn((method: string, _params: unknown) =>
    method === 'ui.showNotification' ? answer() : Promise.resolve(undefined),
  );
  const api = createApi({
    plugin,
    env: { appVersion: '0.7.1', platform: 'linux', locale: 'en-US', homeDir: '/home/u', userDataDir: '/data' },
    events: new ApiEvents(),
    call,
    settings: () => ({}),
    track: (d) => d,
    registerCommand: () => toDisposable(() => undefined),
    executeCommand: () => Promise.resolve(undefined),
    registerProvider: () => toDisposable(() => undefined),
    registerMcpTool: () => toDisposable(() => undefined),
    reportError: () => undefined,
  });
  return { api, call };
}

const actions = [{ id: 'yes', title: 'Yes' }];

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
