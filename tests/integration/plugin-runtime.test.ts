import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  mcpTools: [],
  panels: [],
  statusBarItems: [],
  ...over,
});

const echo = info('echo', {
  id: 'test.echo',
  permissions: ['projects.read', 'terminals.read-metadata', 'terminals.create', 'terminals.env'],
  activationEvents: ['onStartup'],
  commands: ['echo.hello', 'echo.projects', 'echo.terminals', 'echo.git', 'echo.store', 'echo.setEnv'],
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

  it('reloads a plugin: fresh activation for active plugins, another chance for failed ones', async () => {
    const { runtime, states } = setup();
    await runtime.load([echo, crash], {}, env());
    await runtime.activateByEvent('onStartup');
    const generation = runtime.get('test.echo')!.generation;
    states.length = 0;
    await runtime.reload('test.echo');
    expect(states).toEqual(['test.echo:inactive', 'test.echo:active']);
    expect(runtime.get('test.echo')!.generation).toBeGreaterThan(generation);
    expect(await runtime.executeCommand('echo.hello', [])).toMatchObject({ echo: [] });

    states.length = 0;
    await runtime.reload('test.crash');
    expect(states[0]).toBe('test.crash:inactive');
    expect(states[1]).toMatch(/^test\.crash:failed:.*boom on activate/);
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

describe('PluginRuntime MCP tools', () => {
  const mcp = info('mcp-tools', {
    id: 'test.mcp',
    permissions: ['mcp.tools'],
    activationEvents: [
      'onMcpTool:tests_echo',
      'onMcpTool:tests_wait',
      'onMcpTool:tests_reset',
      'onCommand:tests.addDynamic',
    ],
    commands: ['tests.addDynamic', 'tests.removeDynamic'],
    mcpPrefix: 'tests',
    mcpTools: ['tests_echo', 'tests_wait', 'tests_reset'],
  });
  const call = (runtime: PluginRuntime, name: string, extra: { callId?: string; timeoutMs?: number } = {}) =>
    runtime.callMcpTool({
      callId: extra.callId ?? name,
      pluginId: 'test.mcp',
      name,
      args: { text: 'hi' },
      context: { projectId: 'p1', terminalId: 't-1' },
      timeoutMs: extra.timeoutMs ?? 5000,
    });

  it('activates the plugin on the first call and passes the caller context', async () => {
    const { runtime, states } = setup();
    await runtime.load([mcp], {}, env());
    expect(runtime.get('test.mcp')?.state).toBe('inactive');
    expect(await call(runtime, 'tests_echo')).toEqual({
      content: [{ type: 'text', text: 'echo: hi' }],
      structuredContent: { projectId: 'p1', terminalId: 't-1' },
    });
    expect(states).toContain('test.mcp:active');
    expect(await call(runtime, 'tests_reset')).toEqual({ content: [{ type: 'text', text: 'reset done' }] });
    expect(await call(runtime, 'tests_missing')).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The tool tests_missing is not available.' }],
    });
  });

  it('aborts a call on cancel, timeout and deactivation', async () => {
    const { runtime } = setup();
    await runtime.load([mcp], {}, env());
    const cancelled = call(runtime, 'tests_wait', { callId: 'c1' });
    await vi.waitFor(() => expect(runtime.get('test.mcp')?.state).toBe('active'));
    await new Promise((r) => setTimeout(r, 20));
    runtime.cancelMcpCall('c1');
    expect(await cancelled).toEqual({ isError: true, content: [{ type: 'text', text: 'Cancelled.' }] });
    expect(await call(runtime, 'tests_wait', { timeoutMs: 100 })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'tests_wait did not finish within 0 s.' }],
    });
    const pending = call(runtime, 'tests_wait', { callId: 'c3' });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.deactivate('test.mcp');
    expect((await pending).isError).toBe(true);
  });

  it('registers runtime tools with main and unregisters them', async () => {
    const { runtime, calls } = setup();
    await runtime.load([mcp], {}, env());
    await runtime.executeCommand('tests.addDynamic', []);
    const registered = calls.find((c) => c.method === 'mcp.registerDynamicTool')?.params as {
      definition: { name: string };
    };
    expect(registered.definition.name).toBe('tests_dynamic');
    expect(await call(runtime, 'tests_dynamic')).toEqual({ content: [{ type: 'text', text: 'dynamic works' }] });
    await runtime.executeCommand('tests.removeDynamic', []);
    expect(calls.find((c) => c.method === 'mcp.unregisterDynamicTool')?.params).toEqual({ name: 'tests_dynamic' });
  });
});
