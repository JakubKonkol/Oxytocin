import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestSchema } from '../../src/shared/domain/plugin';
import { defaultSettings, type Settings } from '../../src/shared/domain/settings';
import { Emitter } from '../../src/shared/utils/emitter';
import { McpHub, type McpHubDeps } from '../../src/main/services/mcp/mcp-hub';
import { CodeMapCheckouts } from '../../src/code-map-host/checkouts';
import { fileRecord } from '../../src/code-map-host/extract/files';
import { copyCodeMapAssets } from '../../scripts/code-map-assets';
import { CodeMapQueryResultSchema } from '../../src/shared/domain/code-map-query';
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
async function setup(codeMap?: McpHubDeps['codeMap']) {
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
    codex: {
      home: () => '/nowhere/.codex',
      platform: 'linux',
      fs: {
        readText: () => Promise.resolve(null),
        writeText: () => Promise.resolve(),
        exists: () => Promise.resolve(false),
      },
    },
    logger: silentLogger,
    ...(codeMap ? { codeMap } : {}),
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

it('queries a live Code Map over HTTP, observes immediate edits, bounds results and revokes cached tools', async () => {
  const assets = join(userData, 'assets');
  await copyCodeMapAssets(assets);
  const root = await mkdtemp(join(tmpdir(), 'oxy-mcp-map-'));
  let enabled = true;
  const changed = new Emitter<void>();
  const checkouts = new CodeMapCheckouts('Oxytocin test', () => {}, {
    assets,
    parserEntry: '',
    parser: {
      parse: (path, source) => {
        const record = fileRecord(path, source);
        record.symbols.push({
          id: `s:${path}:${source}`,
          file: record.file.id,
          name: source,
          kind: 'function',
          signature: `function ${source}()`,
          owner: null,
          exported: true,
          span: [1, 0, 1, source.length],
        });
        return Promise.resolve(record);
      },
      dispose: async () => {},
    },
  });
  cleanup.push(async () => {
    await checkouts.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'api.ts'), 'beforeEdit');
  await checkouts.configure({
    checkoutId: 'p1',
    projectId: 'p1',
    root,
    mode: 'project',
    gitPath: 'git',
    ignoreInGit: false,
  });
  const { hub, port } = await setup({
    enabled: () => enabled,
    onDidChange: changed.event,
    service: {
      query: async (id, query) => {
        if (!enabled || id !== 'p1') throw new Error('Code Map disabled');
        return CodeMapQueryResultSchema.parse(await checkouts.query(id, crypto.randomUUID(), query));
      },
    },
  });
  const init = await post(port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  const session = init.session;
  expect(init.json.result!['instructions']).toContain('oxy_find_code');
  const names = (await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session)).json.result!.tools!.map(
    (t) => t.name,
  );
  expect(names).toContain('oxy_file_outline');
  const call = async (name: string, args: unknown) =>
    (await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, session)).json
      .result!;
  const text = (r: Record<string, unknown>) => (r['content'] as { text: string }[])[0]!.text;
  expect(text(await call('oxy_find_code', { query: 'beforeEdit' }))).toContain('beforeEdit');
  await writeFile(join(root, 'api.ts'), 'afterEdit');
  const updated = text(await call('oxy_find_code', { query: 'afterEdit', maxChars: 2000 }));
  expect(updated).toContain('afterEdit');
  expect(updated.length).toBeLessThanOrEqual(2000);
  expect(text(await call('oxy_file_outline', { path: 'api.ts' }))).toContain('afterEdit');
  expect(text(await call('oxy_code_relations', { path: 'api.ts' }))).toContain('whyIncluded');
  expect(text(await call('oxy_repo_map', {}))).toContain('## Layout');
  expect(text(await call('oxy_code_map_status', {}))).toContain('coverage');
  if (process.env['OXYTOCIN_CODE_MAP_QUERY_BENCHMARK'] === '1') {
    const timings: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const response = await call('oxy_find_code', { query: 'afterEdit' });
      expect(text(response)).toContain('afterEdit');
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/code-map-stage06-mcp.json',
      JSON.stringify(
        {
          fixtureFiles: 1,
          samples: timings.length,
          medianMs: timings[24],
          p95Ms: timings[47],
          maxMs: timings[49],
          node: process.version,
          platform: process.platform,
        },
        null,
        2,
      ),
    );
  }
  expect((await call('oxy_find_code', { query: 'afterEdit', project: 'unknown' }))['isError']).toBe(true);
  enabled = false;
  // Cached registry entry is still listed until the change event; dispatch checks the current opt-in.
  expect((await call('oxy_find_code', { query: 'afterEdit' }))['isError']).toBe(true);
  changed.fire();
  expect(hub.registry.resolve('oxy_find_code')).toBeUndefined();
  expect(JSON.stringify(hub.state().log)).not.toContain('afterEdit');
});

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
