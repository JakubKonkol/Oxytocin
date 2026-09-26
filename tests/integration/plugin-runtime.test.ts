import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostPluginInfo } from '../../src/shared/rpc/contracts/plugin-host';
import { PluginRuntime } from '../../src/plugin-host/runtime';

const fixtures = resolve(__dirname, '../fixtures/plugins');
let userData: string;

const info = (dir: string, over: Partial<HostPluginInfo>): HostPluginInfo => ({
  id: 'x',
  version: '1.0.0',
  path: join(fixtures, dir),
  main: join(fixtures, dir, 'host.js'),
  builtin: false,
  permissions: [],
  activationEvents: [],
  commands: [],
  views: [],
  panels: [],
  statusBarItems: [],
  ...over,
});

const echo = info('echo', {
  id: 'test.echo',
  permissions: ['projects.read', 'terminals.read-metadata', 'terminals.create', 'terminals.env'],
  activationEvents: ['onStartup'],
  commands: ['echo.hello', 'echo.projects', 'echo.terminals', 'echo.git', 'echo.store'],
  statusBarItems: ['echo.status'],
  configurationPrefix: 'echo',
});
const crash = info('crash-on-activate', { id: 'test.crash', activationEvents: ['onStartup'] });

function setup() {
  const calls: { pluginId: string; method: string; params: unknown }[] = [];
  const states: string[] = [];
  const runtime = new PluginRuntime({
    call: (pluginId, method, params) => {
      calls.push({ pluginId, method, params });
      if (method === 'projects.list') return Promise.resolve([{ id: 'p', name: 'api', rootPath: '/p', color: '#fff' }]);
      if (method === 'terminals.list') return Promise.resolve([]);
      return Promise.resolve(undefined);
    },
    state: (id, state, error) => states.push(`${id}:${state}${error ? `:${error}` : ''}`),
    busy: () => undefined,
    log: () => undefined,
  });
  return { runtime, calls, states };
}

const env = () => ({
  appVersion: '0.0.1',
  platform: 'linux' as const,
  locale: 'en-US',
  homeDir: '/home',
  userDataDir: userData,
});

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oxy-plugins-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('PluginRuntime', () => {
  it('activates on startup, runs commands and isolates a crashing plugin', async () => {
    const { runtime, calls, states } = setup();
    await runtime.load([echo, crash], { 'echo.greeting': 'Hi' }, env());
    const activated = await runtime.activateByEvent('onStartup');
    expect(activated.sort()).toEqual(['test.crash', 'test.echo']);
    expect(states).toContain('test.echo:active');
    expect(states.find((s) => s.startsWith('test.crash:failed'))).toMatch(/boom on activate/);

    expect(await runtime.executeCommand('echo.hello', [1, 'a'])).toEqual({ echo: [1, 'a'], greeting: 'Hi' });
    expect(await runtime.executeCommand('echo.projects', [])).toEqual([
      { id: 'p', name: 'api', rootPath: '/p', color: '#fff' },
    ]);
    await expect(runtime.executeCommand('echo.git', [])).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(await runtime.executeCommand('echo.store', [{ n: 1 }])).toEqual({ n: 1 });
    expect(runtime.logs('test.echo').map((l) => l.message)).toContain('echo activated');

    // Status bar and environment contributions reach main (debounced).
    await new Promise((r) => setTimeout(r, 100));
    const paramsOf = (method: string) => calls.find((c) => c.method === method)?.params;
    expect(paramsOf('ui.statusBarItem')).toMatchObject({ id: 'echo.status', text: '$(pulse) echo', visible: true });
    expect(paramsOf('terminals.environment')).toMatchObject({
      entries: [{ op: 'replace', name: 'OXY_ECHO', value: 'from-echo' }],
    });
    expect(calls.some((c) => c.method === 'terminals.environmentReady')).toBe(true);
  });

  it('deactivates plugins (disposing commands) and re-activates with a fresh module', async () => {
    const { runtime, states } = setup();
    await runtime.load([echo], {}, env());
    await runtime.activateByEvent('onStartup');
    await runtime.deactivate('test.echo');
    expect(states).toContain('test.echo:inactive');
    // Commands of a declared plugin activate it again on demand.
    expect(await runtime.executeCommand('echo.hello', [])).toMatchObject({ echo: [] });
    expect(runtime.get('test.echo')?.state).toBe('active');
    await expect(runtime.executeCommand('nope.command', [])).resolves.toBeUndefined();
  });

  it('unloads plugins removed from the list', async () => {
    const { runtime, states } = setup();
    await runtime.load([echo], {}, env());
    await runtime.activateByEvent('onStartup');
    await runtime.load([], {}, env());
    expect(runtime.get('test.echo')).toBeUndefined();
    expect(states.at(-1)).toBe('test.echo:inactive');
  });

  it('attributes errors to plugins by their folder in the stack', async () => {
    const { runtime } = setup();
    await runtime.load([echo], {}, env());
    const error = new Error('late failure');
    error.stack = `Error: late failure\n    at x (${join(fixtures, 'echo', 'host.js')}:3:1)`;
    expect(runtime.pluginForError(error)).toBe('test.echo');
    expect(runtime.pluginForError(new Error('core'))).toBeUndefined();
  });
});
