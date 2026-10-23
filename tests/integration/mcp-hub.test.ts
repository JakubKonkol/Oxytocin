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
import { LearningToolResultSchema } from '../../src/shared/domain/code-map-learning-tools';
import { LearningMemory } from '../../src/code-map-host/memory/admission';
import { LearningTools } from '../../src/code-map-host/memory/agent-tools';
import type { MemoryAuthority } from '../../src/shared/domain/code-map-memory';
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

it('uses three learning tools over real HTTP with independent sessions, review and evidence invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oxy-mcp-learning-')),
    assets = join(userData, 'learning-assets');
  await copyCodeMapAssets(assets);
  const checkouts = new CodeMapCheckouts('Oxytocin test', () => {}, {
    assets,
    parserEntry: '',
    parser: {
      parse: (path, source) => {
        const record = fileRecord(path, source);
        record.file.status = 'ok';
        return Promise.resolve(record);
      },
      dispose: () => Promise.resolve(),
    },
  });
  cleanup.push(async () => {
    await checkouts.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'api.ts'), 'export const protocol = 1;\n');
  await checkouts.configure({
    checkoutId: 'p1',
    projectId: 'p1',
    root,
    mode: 'project',
    gitPath: 'git',
    ignoreInGit: false,
  });
  await vi.waitFor(() => expect(checkouts.status('p1').state).toBe('ready'));
  const memory = new LearningMemory((id) => checkouts.memorySnapshot(id));
  cleanup.push(() => memory.dispose());
  const tools = new LearningTools(checkouts, memory);
  const authority: MemoryAuthority = {
    projectId: 'p1',
    checkoutId: 'p1',
    root,
    projectRoot: root,
    checkouts: [{ checkoutId: 'p1', root }],
    excludedPaths: [],
    origin: { source: 'user' },
  };
  let enabled = true,
    mode: 'off' | 'review' = 'review';
  const changed = new Emitter<void>();
  const { hub, port } = await setup({
    enabled: () => enabled,
    memoryEnabled: () => enabled && mode !== 'off',
    onDidChange: changed.event,
    service: {
      query: async (id, query) => CodeMapQueryResultSchema.parse(await checkouts.query(id, crypto.randomUUID(), query)),
    },
    learningService: {
      learningTool: (projectId, checkoutId, request, actor) => {
        if (!enabled || projectId !== 'p1' || checkoutId !== 'p1') throw new Error('UNAVAILABLE');
        return tools.run(crypto.randomUUID(), authority, actor, request, mode);
      },
      revokeLearningActor: (principal) => tools.revokeActor(principal),
    },
  });
  const initialize = async () =>
    (await post(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
      .session;
  const firstSession = await initialize(),
    secondSession = await initialize();
  const call = async (session: string, name: string, args: unknown) =>
    (await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, session)).json
      .result!;
  const decode = (result: Record<string, unknown>) =>
    LearningToolResultSchema.parse(JSON.parse((result['content'] as { text: string }[])[0]!.text));
  const proposal = {
    draft: {
      kind: 'constraint',
      title: 'Protocol compatibility',
      body: 'Use the protocol.',
      evidence: [{ path: 'api.ts' }],
    },
    expectedRevision: 0,
    idempotencyKey: 'http-proposal',
  };
  const proposed = decode(await call(firstSession, 'oxy_propose_learning', proposal));
  expect(proposed).toMatchObject({ kind: 'propose', code: 'OK', review: 'proposed' });
  if (proposed.kind !== 'propose') throw new Error('Expected a proposal');
  expect(decode(await call(firstSession, 'oxy_task_context', { question: 'protocol', format: 'json' }))).toMatchObject({
    learnings: [],
  });
  await memory.run(authority, {
    action: 'review',
    id: proposed.id,
    expectedRevision: proposed.revision,
    decision: 'accept',
    idempotencyKey: 'http-review',
  });
  const compact = await call(secondSession, 'oxy_task_context', { question: 'protocol', paths: ['api.ts'] });
  expect((compact['content'] as { text: string }[])[0]!.text).toContain('receipt=');
  expect((compact['content'] as { text: string }[])[0]!.text).toContain('Use the protocol.');
  const context = decode(
    await call(secondSession, 'oxy_task_context', { question: 'protocol', paths: ['api.ts'], format: 'json' }),
  );
  if (context.kind !== 'task-context') throw new Error(JSON.stringify(context));
  expect(context.learnings[0]).toMatchObject({
    id: proposed.id,
    origin: { source: 'agent', role: 'hub' },
    reviewer: { source: 'user' },
  });
  const feedback = {
    receipt: context.receipt,
    id: proposed.id,
    revision: context.learnings[0]!.revision,
    outcome: 'used',
    idempotencyKey: 'http-feedback',
  };
  expect(decode(await call(firstSession, 'oxy_learning_feedback', feedback))).toMatchObject({
    code: 'INVALID_RECEIPT',
  });
  expect(decode(await call(secondSession, 'oxy_learning_feedback', feedback))).toMatchObject({
    kind: 'feedback',
    code: 'OK',
  });
  expect(
    (await call(firstSession, 'oxy_propose_learning', { ...proposal, author: 'user', role: 'another-role' }))[
      'isError'
    ],
  ).toBe(true);
  expect(decode(await call(secondSession, 'oxy_task_context', { question: 'protocol', maxChars: 1 }))).toMatchObject({
    code: 'BUDGET_TOO_SMALL',
  });
  await writeFile(join(root, 'api.ts'), 'export const protocol = 2;\n');
  expect(decode(await call(secondSession, 'oxy_task_context', { question: 'protocol', format: 'json' }))).toMatchObject(
    {
      learnings: [],
    },
  );
  expect(hub.registry.resolve('oxy_task_context')).toBeDefined();
  mode = 'off';
  tools.revoke('p1');
  expect(decode(await call(secondSession, 'oxy_task_context', { question: 'protocol', format: 'json' }))).toMatchObject(
    {
      memory: 'off',
      learnings: [],
    },
  );
  expect(decode(await call(secondSession, 'oxy_propose_learning', proposal))).toMatchObject({ code: 'MEMORY_OFF' });
  changed.fire();
  expect(hub.registry.resolve('oxy_propose_learning')).toBeUndefined();
  expect(hub.registry.resolve('oxy_task_context')).toBeUndefined();
  enabled = false;
  changed.fire();
  expect(hub.registry.resolve('oxy_task_context')).toBeUndefined();
  expect(JSON.stringify(hub.state().log)).not.toContain('Use the protocol.');
});

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
  expect(text(await call('oxy_find_code', { query: 'beforeEdit' }))).toBe('api.ts:1-1 function beforeEdit()');
  await writeFile(join(root, 'api.ts'), 'afterEdit');
  const updated = text(await call('oxy_find_code', { query: 'afterEdit', maxChars: 2000 }));
  expect(updated).toContain('afterEdit');
  expect(updated.length).toBeLessThanOrEqual(2000);
  expect(text(await call('oxy_file_outline', { path: 'api.ts' }))).toContain('afterEdit');
  expect(text(await call('oxy_code_relations', { path: 'api.ts', format: 'json' }))).toContain('whyIncluded');
  expect(text(await call('oxy_repo_map', {}))).toContain('## Layout');
  expect(text(await call('oxy_code_relations', { path: 'api.ts', line: 1 }))).toContain(
    '1 api.ts:1-1 function afterEdit()',
  );
  expect(names).not.toContain('oxy_code_map_status');
  expect(names).not.toContain('oxy_task_context');
  expect(hub.registry.resolve('oxy_code_map_status')).toBeUndefined();
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
  const unknown = await call('oxy_find_code', { query: 'afterEdit', project: 'unknown' });
  expect(unknown['isError']).toBe(true);
  // A selector the agent can fix is explained instead of reported as a generic failure.
  expect(text(unknown)).toContain('Project is unknown or ambiguous');
  const invalid = await call('oxy_find_code', { query: 'afterEdit', limit: 51 });
  expect(text(invalid)).toContain('Invalid Code Map arguments');
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
