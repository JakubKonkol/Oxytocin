import { describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '@shared/domain/settings';
import { type PluginDescriptor, PluginManifestSchema } from '@shared/domain/plugin';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { PluginHostService, type PluginCorePort } from './plugin-host-service';

const descriptor = (id: string, manifest: Record<string, unknown> = {}): PluginDescriptor => ({
  id,
  version: '1.0.0',
  displayName: id,
  source: 'dev',
  path: `/plugins/${id}`,
  state: 'enabled',
  manifest: PluginManifestSchema.parse({
    id,
    displayName: id,
    publisher: 't',
    engine: '^0.1.0',
    main: 'host.js',
    ...manifest,
  }),
});

function setup() {
  const ready = new Emitter<{ pid: number; restarted: boolean }>();
  const events = new Map<string, (p: unknown) => void>();
  let served: Record<string, (p: never) => unknown> = {};
  const calls: { method: string; params: unknown }[] = [];
  const host = {
    state: 'running' as const,
    call: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(method === 'plugins:activateByEvent' ? [] : undefined);
    }),
    emit: vi.fn(),
    serve: (m: Record<string, (p: never) => unknown>) => {
      served = { ...served, ...m };
      return toDisposable(() => undefined);
    },
    onEvent: (name: string, l: (p: unknown) => void) => {
      events.set(name, l);
      return toDisposable(() => undefined);
    },
    onDidBecomeReady: ready.event,
  };
  const list = [descriptor('a.one', { permissions: ['projects.read'] }), descriptor('b.two')];
  const runtime = new Map<string, string>();
  const plugins = {
    enabled: () => list.filter((p) => runtime.get(p.id) !== 'failed'),
    get: (id: string) => list.find((p) => p.id === id),
    onDidChange: new Emitter<PluginDescriptor[]>().event,
    setRuntimeState: vi.fn((id: string, state: string) => runtime.set(id, state)),
  };
  const core = {
    projects: {
      list: () => [
        { id: 'p', name: 'api', rootPath: '/p', color: 2, pinned: false, order: 0, createdAt: 0, settings: {} },
      ],
      get: () => undefined,
      activeId: () => null,
      findByPath: () => undefined,
    },
    terminals: { list: () => [], get: () => undefined, create: vi.fn(), write: vi.fn() },
    agents: { list: () => [], reportSession: vi.fn() },
    git: { status: () => null },
    settings: () => resolveSettings({}, 'linux').settings,
    updateSettings: vi.fn(),
    openExternal: vi.fn(),
    openInEditor: vi.fn(),
    toRenderer: vi.fn(),
    osNotify: vi.fn(),
  } as unknown as PluginCorePort;
  const service = new PluginHostService({
    host: host as never,
    plugins: plugins,
    core,
    env: { appVersion: '1', platform: 'linux', locale: 'en', homeDir: '/h', userDataDir: '/u' },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  });
  const api = (pluginId: string, method: string, params: unknown = {}) =>
    (served['api:call'] as unknown as (r: unknown) => Promise<unknown>)({ pluginId, method, params });
  return { service, api, calls, events, ready, plugins, core };
}

describe('PluginHostService', () => {
  it('loads enabled plugins and fires onStartup', async () => {
    const s = setup();
    await s.service.reload();
    const load = s.calls.find((c) => c.method === 'plugins:load')!.params as {
      plugins: { id: string; main: string }[];
    };
    expect(load.plugins.map((p) => [p.id, p.main])).toEqual([
      ['a.one', '/plugins/a.one/host.js'],
      ['b.two', '/plugins/b.two/host.js'],
    ]);
    expect(s.calls).toContainEqual({ method: 'plugins:activateByEvent', params: { event: 'onStartup' } });
  });

  it('checks permissions again in main and maps project colours', async () => {
    const s = setup();
    expect(await s.api('a.one', 'projects.list')).toEqual([{ id: 'p', name: 'api', rootPath: '/p', color: '#f5a524' }]);
    await expect(s.api('b.two', 'projects.list')).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(s.api('b.two', 'ui.openExternal', { url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: 'PERMISSION',
    });
    await expect(s.api('b.two', 'settings.update', { key: 'terminal.fontSize', value: 1 })).rejects.toMatchObject({
      code: 'PERMISSION',
    });
    await expect(s.api('b.two', 'commands.executeCore', { id: 'rm.rf', args: [] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('attributes a hang to the busy plugin and excludes it after two incidents', async () => {
    const s = setup();
    await s.service.reload();
    s.events.get('plugin:busy')!({ id: 'b.two' });
    s.ready.fire({ pid: 2, restarted: true });
    expect(s.plugins.setRuntimeState).not.toHaveBeenCalledWith('b.two', 'failed', expect.anything());
    s.events.get('plugin:busy')!({ id: 'b.two' });
    s.ready.fire({ pid: 3, restarted: true });
    expect(s.plugins.setRuntimeState).toHaveBeenCalledWith('b.two', 'failed', expect.stringMatching(/twice/));
    await s.service.reload();
    const lastLoad = s.calls.filter((c) => c.method === 'plugins:load').at(-1)!.params as { plugins: { id: string }[] };
    expect(lastLoad.plugins.map((p) => p.id)).toEqual(['a.one']);
  });

  it('keeps status bar items and environment contributions per plugin', async () => {
    const s = setup();
    const items: unknown[] = [];
    s.service.onDidChangeStatusBar((list) => items.push(list));
    await expect(s.api('b.two', 'ui.statusBarItem', { id: 'nope', text: 'x', visible: true })).rejects.toMatchObject({
      code: 'INVALID',
    });
    await expect(s.api('b.two', 'terminals.environment', { entries: [] })).rejects.toMatchObject({
      code: 'PERMISSION',
    });
    s.events.get('plugin:state')!({ id: 'b.two', state: 'inactive' });
    expect(items).toEqual([]);
  });
});
