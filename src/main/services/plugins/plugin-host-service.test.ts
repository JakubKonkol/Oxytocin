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

function setup(opts: { list?: PluginDescriptor[]; envBarrierMs?: number } = {}) {
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
  const list = opts.list ?? [descriptor('a.one', { permissions: ['projects.read'] }), descriptor('b.two')];
  const runtime = new Map<string, string>();
  const plugins = {
    enabled: () => list.filter((p) => runtime.get(p.id) !== 'failed'),
    get: (id: string) => {
      const d = list.find((p) => p.id === id);
      return d && runtime.get(id) === 'failed' ? { ...d, state: 'failed' as const } : d;
    },
    onDidChange: new Emitter<PluginDescriptor[]>().event,
    setRuntimeState: vi.fn((id: string, state: string) => runtime.set(id, state)),
  };
  const toRenderer = vi.fn();
  const terminal = {
    id: 't1',
    projectId: 'p',
    profileId: 'bash',
    profileName: 'bash',
    title: 'web',
    pid: 42,
    cwd: '/p',
    shellType: 'bash',
    kind: 'process',
    state: 'running',
    createdAt: 1,
    envStale: false,
    bell: false,
    background: true,
    lastCommand: { commandLine: 'npm run dev', exitCode: 1, durationMs: 5, finishedAt: 9 },
  };
  const quickPick = vi.fn(() => Promise.resolve(1));
  const notifyWithActions = vi.fn(() => Promise.resolve('yes' as string | null));
  const terms = {
    list: () => [],
    get: (id: string) => (id === 't1' ? terminal : undefined),
    create: vi.fn(() => Promise.resolve(terminal)),
    write: vi.fn(),
    markShown: vi.fn(),
    kill: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    watchOutput: vi.fn(() => Promise.resolve()),
    unwatchAllOutput: vi.fn(() => Promise.resolve()),
    listeningPorts: vi.fn(() => Promise.resolve([5173])),
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
    terminals: terms,
    agents: { list: () => [], reportSession: vi.fn() },
    git: { status: () => null },
    settings: () => resolveSettings({}, 'linux').settings,
    updateSettings: vi.fn(),
    openExternal: vi.fn(),
    openInEditor: vi.fn(),
    quickPick,
    notifyWithActions,
    toRenderer,
    osNotify: vi.fn(),
  } as unknown as PluginCorePort;
  const service = new PluginHostService({
    host: host as never,
    plugins: plugins,
    core,
    env: { appVersion: '1', platform: 'linux', locale: 'en', homeDir: '/h', userDataDir: '/u' },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...(opts.envBarrierMs !== undefined ? { envBarrierMs: opts.envBarrierMs } : {}),
  });
  const api = (pluginId: string, method: string, params: unknown = {}) =>
    (served['api:call'] as unknown as (r: unknown) => Promise<unknown>)({ pluginId, method, params });
  return { service, api, calls, events, ready, plugins, core, terms, toRenderer, quickPick, notifyWithActions };
}

describe('PluginHostService', () => {
  describe('start-up barrier for terminal environments', () => {
    const envPlugin = () => descriptor('env.one', { permissions: ['terminals.env'], activationEvents: ['onStartup'] });

    it('waits until an onStartup plugin with terminals.env declares its environment ready', async () => {
      const s = setup({ list: [envPlugin()] });
      let open = false;
      void s.service.envBarrier().then(() => (open = true));
      await Promise.resolve();
      expect(open).toBe(false);
      await s.api('env.one', 'terminals.environmentReady');
      await Promise.resolve();
      expect(open).toBe(true);
    });

    it('gives up after envBarrierMs (2 s by default)', async () => {
      vi.useFakeTimers();
      try {
        const s = setup({ list: [envPlugin()], envBarrierMs: 5000 });
        let open = false;
        void s.service.envBarrier().then(() => (open = true));
        await vi.advanceTimersByTimeAsync(2500);
        expect(open).toBe(false);
        await vi.advanceTimersByTimeAsync(2600);
        expect(open).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

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

  it('validates quick picks and returns the chosen index', async () => {
    const s = setup();
    const items = [{ label: 'a' }, { label: 'b', description: 'docs', detail: 'more' }];
    expect(await s.api('b.two', 'ui.showQuickPick', { items, placeholder: 'Pick one' })).toBe(1);
    expect(s.quickPick).toHaveBeenCalledWith(items, {
      placeholder: 'Pick one',
      source: s.plugins.get('b.two')!.displayName,
    });
    await expect(s.api('b.two', 'ui.showQuickPick', { items: [{ label: 3 }] })).rejects.toMatchObject({
      code: 'INVALID',
    });
    await expect(
      s.api('b.two', 'ui.showQuickPick', { items: Array.from({ length: 5001 }, () => ({ label: 'x' })) }),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('shows notifications, with buttons returning the clicked action', async () => {
    const s = setup();
    expect(await s.api('b.two', 'ui.showNotification', { level: 'warning', message: 'Hi', detail: 'more' })).toBe(null);
    expect(s.toRenderer).toHaveBeenCalledWith('toast', { kind: 'warning', message: 'Hi', description: 'more' });
    const actions = [
      { id: 'yes', title: 'Yes' },
      { id: 'show', title: 'Show Terminal' },
    ];
    expect(await s.api('b.two', 'ui.showNotification', { level: 'info', message: 'Ask', actions })).toBe('yes');
    expect(s.notifyWithActions).toHaveBeenCalledWith({ kind: 'info', message: 'Ask', actions });
    // Invalid buttons: a plain toast.
    s.toRenderer.mockClear();
    expect(await s.api('b.two', 'ui.showNotification', { message: 'x', actions: [{ id: '', title: '' }] })).toBe(null);
    expect(s.toRenderer).toHaveBeenCalledWith('toast', { kind: 'info', message: 'x' });
    expect(s.notifyWithActions).toHaveBeenCalledTimes(1);
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

    // Plugins → Reload gives it another chance and reloads its views.
    await s.service.reloadPlugin('b.two');
    expect(s.plugins.setRuntimeState).toHaveBeenCalledWith('b.two', 'inactive');
    const reloaded = s.calls.filter((c) => c.method === 'plugins:load').at(-1)!.params as {
      plugins: { id: string }[];
    };
    expect(reloaded.plugins.map((p) => p.id)).toEqual(['a.one', 'b.two']);
    expect(s.calls.at(-1)).toEqual({ method: 'plugins:reload', params: { id: 'b.two' } });
    expect(s.toRenderer).toHaveBeenCalledWith('pluginReloaded', { id: 'b.two' });
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

describe('PluginHostService views', () => {
  it('opens declared views only and limits message size and rate', async () => {
    const s = setup();
    const withView = descriptor('c.three', {
      contributes: { panels: [{ type: 'c.panel', title: 'C', entry: 'v.html' }] },
    });
    (s.plugins as unknown as { get: (id: string) => PluginDescriptor | undefined }).get = (id) =>
      id === 'c.three' ? withView : undefined;
    await expect(
      s.service.viewOpened({ viewId: 'v', pluginId: 'c.three', kind: 'panel', providerId: 'nope', visible: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await s.service.viewOpened({
      viewId: 'v',
      pluginId: 'c.three',
      kind: 'panel',
      providerId: 'c.panel',
      visible: true,
    });
    expect(s.calls).toContainEqual({ method: 'plugins:activateByEvent', params: { event: 'onPanel:c.panel' } });
    expect(s.calls.find((c) => c.method === 'views:open')).toBeTruthy();

    await expect(
      s.service.viewMessage('v', { kind: 'msg', payload: 'x'.repeat(1024 * 1024 + 10) }),
    ).rejects.toMatchObject({ code: 'INVALID' });
    const results = await Promise.allSettled(
      Array.from({ length: 205 }, () => s.service.viewMessage('v', { kind: 'msg', payload: 1 })),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
    await expect(s.service.viewMessage('unknown', { kind: 'msg', payload: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  describe('terminals API (0.1.4)', () => {
    const runner = () =>
      descriptor('run.ner', {
        permissions: ['terminals.create', 'terminals.write', 'terminals.read-metadata', 'terminals.read-output'],
      });

    it('creates background terminals without opening a panel and passes env', async () => {
      const s = setup({ list: [runner()] });
      const meta = await s.api('run.ner', 'terminals.create', {
        projectId: 'p',
        command: 'npm run dev',
        env: { PORT: '4000' },
        reveal: false,
      });
      expect(s.terms.create).toHaveBeenCalledWith({
        projectId: 'p',
        initialCommand: 'npm run dev',
        env: { PORT: '4000' },
        background: true,
      });
      expect(s.toRenderer).not.toHaveBeenCalledWith('openTerminalPanel', expect.anything());
      expect(meta).toMatchObject({ id: 't1', cwd: '/p', background: true, lastCommand: { exitCode: 1 } });
      await expect(s.api('run.ner', 'terminals.create', { projectId: 'p', env: { A: 1 } })).rejects.toMatchObject({
        code: 'INVALID',
      });
    });

    it('shows, kills and closes terminals and reports listening ports', async () => {
      const s = setup({ list: [runner(), descriptor('b.two')] });
      await s.api('run.ner', 'terminals.show', { id: 't1', preserveFocus: true, placement: 'below' });
      expect(s.terms.markShown).toHaveBeenCalledWith('t1');
      expect(s.toRenderer).toHaveBeenCalledWith('openTerminalPanel', {
        terminalId: 't1',
        projectId: 'p',
        placement: 'below',
        focus: false,
      });
      await s.api('run.ner', 'terminals.kill', { id: 't1', force: true });
      expect(s.terms.kill).toHaveBeenCalledWith('t1', true);
      await s.api('run.ner', 'terminals.close', { id: 't1' });
      expect(s.toRenderer).toHaveBeenCalledWith('closeTerminalPanel', { terminalId: 't1', projectId: 'p' });
      expect(s.terms.close).toHaveBeenCalledWith('t1');
      expect(await s.api('run.ner', 'terminals.listeningPorts', { id: 't1' })).toEqual([5173]);
      await expect(s.api('run.ner', 'terminals.kill', { id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(s.api('b.two', 'terminals.kill', { id: 't1' })).rejects.toMatchObject({ code: 'PERMISSION' });
    });

    it('forwards output only for watched terminals and stops watching when the plugin goes inactive', async () => {
      const s = setup({ list: [runner()] });
      s.service.notifyTerminalOutput('t1', 'before');
      await s.api('run.ner', 'terminals.watchOutput', { id: 't1', watch: true });
      expect(s.terms.watchOutput).toHaveBeenCalledWith('t1', 'plugin:run.ner', true);
      s.service.notifyTerminalOutput('t1', 'Local: http://localhost:5173/');
      s.events.get('plugin:state')?.({ id: 'run.ner', state: 'inactive' });
      s.service.notifyTerminalOutput('t1', 'after');
      const host = (s.service as unknown as { deps: { host: { emit: ReturnType<typeof vi.fn> } } }).deps.host;
      const outputs = host.emit.mock.calls.filter(
        (c: unknown[]) => (c[1] as { name: string }).name === 'terminals.output',
      );
      expect(outputs.map((c: unknown[]) => (c[1] as { payload: { data: string } }).payload.data)).toEqual([
        'Local: http://localhost:5173/',
      ]);
      expect(s.terms.unwatchAllOutput).toHaveBeenCalledWith('plugin:run.ner');
    });
  });
});
