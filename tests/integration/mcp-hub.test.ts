import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestSchema } from '../../src/shared/domain/plugin';
import { defaultSettings, type Settings } from '../../src/shared/domain/settings';
import { Emitter } from '../../src/shared/utils/emitter';
import { McpHub } from '../../src/main/services/mcp/mcp-hub';
import type { PluginToolSource } from '../../src/main/services/mcp/tool-registry';
import { PluginRuntime } from '../../src/plugin-host/runtime';
import { silentLogger } from '../helpers/logger';

const fixture = resolve(__dirname, '../fixtures/plugins/mcp-tools');
let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oxy-mcp-'));
});
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
  await rm(userData, { recursive: true, force: true });
});

/** The hub with the fixture plugin running in a real PluginRuntime (as in the Plugin Host). */
async function setup() {
  const manifest = PluginManifestSchema.parse(
    (JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8')) as { oxytocin: unknown }).oxytocin,
  );
  const mcp = manifest.contributes.mcp!;
  const runtime = new PluginRuntime({
    call: (pluginId, method, params) => {
      if (method === 'mcp.registerDynamicTool')
        hub.addDynamicTool(pluginId, (params as { definition: unknown }).definition);
      if (method === 'mcp.unregisterDynamicTool') hub.removeDynamicTool(pluginId, (params as { name: string }).name);
      return Promise.resolve(undefined);
    },
    state: () => undefined,
    busy: () => undefined,
    log: () => undefined,
  });
  await runtime.load(
    [
      {
        id: 'test.mcp',
        version: '1.0.0',
        path: fixture,
        main: join(fixture, 'host.js'),
        builtin: false,
        permissions: manifest.permissions,
        activationEvents: manifest.activationEvents,
        commands: manifest.contributes.commands.map((c) => c.id),
        views: [],
        panels: [],
        statusBarItems: [],
        mcpPrefix: mcp.prefix,
        mcpTools: mcp.tools.map((t) => t.name),
      },
    ],
    {},
    { appVersion: '1', platform: 'linux', locale: 'en-US', homeDir: userData, userDataDir: userData },
  );
  let enabled = false;
  const pluginsChanged = new Emitter<void>();
  const settings: Settings = { ...defaultSettings('linux'), 'mcp.port': 0 };
  const sources = (): PluginToolSource[] => [
    {
      pluginId: 'test.mcp',
      pluginName: manifest.displayName,
      builtin: false,
      prefix: mcp.prefix,
      declared: mcp.tools,
      available: enabled,
    },
  ];
  let callCounter = 0;
  const hub: McpHub = new McpHub({
    settings: () => settings,
    onDidChangeSettings: () => ({ dispose: () => undefined }),
    updateSettings: () => Promise.resolve(),
    tokenStore: { get: () => 'secret-token-0123456789', set: () => Promise.resolve() },
    appVersion: '1.0.0',
    core: {
      projects: () => [{ id: 'p1', name: 'Shop', rootPath: '/work/shop' }],
      activeProjectId: () => 'p1',
      branch: () => undefined,
      terminals: () => [],
      terminalText: () => Promise.resolve(''),
      notify: () => undefined,
      ask: () => Promise.resolve(null),
      openFile: () => Promise.resolve(),
      isFile: () => Promise.resolve(false),
      platform: 'linux',
    },
    caller: {
      terminal: (id) => (id === 't-9' ? { id, projectId: 'p1' } : undefined),
      projects: () => [{ id: 'p1', name: 'Shop', rootPath: '/work/shop' }],
      activeProjectId: () => null,
      findByPath: () => undefined,
      realpath: () => Promise.resolve(null),
      platform: 'linux',
    },
    describeTerminal: () => undefined,
    plugins: {
      sources,
      onDidChange: (l) => pluginsChanged.event(() => l()),
      call: ({ signal, ...o }) => {
        const callId = `c${++callCounter}`;
        signal.addEventListener('abort', () => runtime.cancelMcpCall(callId), { once: true });
        return runtime.callMcpTool({ ...o, callId });
      },
      setProblems: () => undefined,
    },
    askPolicy: () => Promise.resolve('once' as const),
    cli: () => Promise.resolve({ ok: false, output: '' }),
    logger: silentLogger,
  });
  await hub.start();
  cleanup.push(async () => {
    await hub.stop();
    hub.dispose();
    await runtime.dispose();
  });
  const port = hub.state().status.port!;
  const setEnabled = (on: boolean) => {
    enabled = on;
    pluginsChanged.fire();
  };
  return { hub, runtime, port, setEnabled };
}

function post(port: number, body: unknown, session?: string): Promise<{ status: number; session: string; json: Rpc }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret-token-0123456789',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Oxytocin-Terminal': 't-9',
          ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            session: String(res.headers['mcp-session-id'] ?? ''),
            json: (text ? JSON.parse(text) : {}) as Rpc,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

interface Rpc {
  result?: { tools?: { name: string }[]; capabilities?: unknown } & Record<string, unknown>;
  error?: unknown;
}

/** Opens the session's SSE stream and collects the notifications. */
function stream(port: number, session: string) {
  const events: string[] = [];
  const req = request({
    host: '127.0.0.1',
    port,
    path: '/mcp',
    headers: {
      Authorization: 'Bearer secret-token-0123456789',
      Accept: 'text/event-stream',
      'Mcp-Session-Id': session,
    },
  });
  req.on('response', (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      for (const line of chunk.split('\n'))
        if (line.startsWith('data: ')) events.push((JSON.parse(line.slice(6)) as { method: string }).method);
    });
  });
  req.on('error', () => undefined);
  req.end();
  cleanup.push(() => Promise.resolve(void req.destroy()));
  return events;
}

const toolNames = async (port: number, session: string) =>
  (await post(port, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, session)).json
    .result!.tools!.map((t) => t.name)
    .filter((n) => n.startsWith('tests_'));

describe('MCP hub with a plugin', () => {
  it('tells connected agents when a plugin adds or removes tools, and runs them', async () => {
    const { port, setEnabled, runtime } = await setup();
    const init = await post(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(init.json.result!.capabilities).toEqual({ tools: { listChanged: true } });
    const session = init.session;
    const events = stream(port, session);
    expect(await toolNames(port, session)).toEqual([]);

    setEnabled(true);
    await vi.waitFor(() => expect(events).toEqual(['notifications/tools/list_changed']));
    expect(await toolNames(port, session)).toEqual(['tests_echo', 'tests_reset', 'tests_wait']);

    // The plugin is activated lazily by the first call; the terminal header selects the project.
    const called = await post(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tests_echo', arguments: { text: 'hi' } } },
      session,
    );
    expect(called.json.result).toEqual({
      content: [{ type: 'text', text: 'echo: hi' }],
      structuredContent: { projectId: 'p1', terminalId: 't-9' },
    });
    expect(runtime.get('test.mcp')?.state).toBe('active');

    // A tool registered at runtime appears too.
    await runtime.executeCommand('tests.addDynamic', []);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(await toolNames(port, session)).toContain('tests_dynamic');

    // Cancelling a call aborts the plugin's handler.
    const waiting = post(
      port,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tests_wait' } },
      session,
    );
    await new Promise((r) => setTimeout(r, 100));
    await post(port, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }, session);
    expect((await waiting).json.result).toEqual({ isError: true, content: [{ type: 'text', text: 'Cancelled.' }] });

    setEnabled(false);
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(await toolNames(port, session)).toEqual([]);
    const gone = await post(
      port,
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tests_echo' } },
      session,
    );
    expect(gone.json.error).toEqual({ code: -32602, message: 'Unknown tool: tests_echo' });
  });

  it('asks the client to initialize again for an unknown session', async () => {
    const { port } = await setup();
    expect((await post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'stale')).status).toBe(404);
  });
});
