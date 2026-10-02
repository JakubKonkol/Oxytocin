import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpToolResult } from '@shared/domain/mcp';
import { defaultSettings, type Settings } from '@shared/domain/settings';
import { Emitter } from '@shared/utils/emitter';
import { type AskPolicyAnswer, McpHub, type McpHubDeps } from './mcp-hub';
import { McpHttpServer } from './http-server';
import type { PluginToolSource } from './tool-registry';
import type { ResourceTool } from './resource-tools';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
const hubs: McpHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
    hub.dispose();
  }
  vi.restoreAllMocks();
});

function setup(
  o: { answer?: AskPolicyAnswer; call?: () => Promise<McpToolResult>; resources?: McpHubDeps['resources'] } = {},
) {
  let settings: Settings = { ...defaultSettings('linux'), 'mcp.port': 0 };
  const settingsChanged = new Emitter<Settings>();
  const pluginsChanged = new Emitter<void>();
  let sources: PluginToolSource[] = [
    {
      pluginId: 'acme.db',
      pluginName: 'Database',
      builtin: false,
      prefix: 'db',
      declared: [
        { name: 'db_query', description: 'Runs a query.', inputSchema: { type: 'object' }, timeoutMs: 1000 },
        {
          name: 'db_drop',
          description: 'Drops.',
          inputSchema: { type: 'object' },
          annotations: { destructiveHint: true },
        },
      ],
      available: true,
    },
  ];
  let token: string | undefined;
  const pluginCall = vi.fn(
    o.call ?? (() => Promise.resolve<McpToolResult>({ content: [{ type: 'text', text: 'rows: 3' }] })),
  );
  const askPolicy = vi.fn((): Promise<AskPolicyAnswer> => Promise.resolve('answer' in o ? (o.answer ?? null) : 'once'));
  const deps: McpHubDeps = {
    settings: () => settings,
    onDidChangeSettings: (l) => settingsChanged.event(l),
    updateSettings: vi.fn((patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
      settingsChanged.fire(settings);
      return Promise.resolve();
    }),
    tokenStore: { get: () => token, set: (t) => Promise.resolve(void (token = t)) },
    appVersion: '1.2.3',
    core: {
      projects: () => [{ id: 'p1', name: 'Shop', rootPath: '/work/shop' }],
      activeProjectId: () => 'p1',
      branch: () => undefined,
      terminals: () => [],
      terminalText: () => Promise.resolve(''),
      notify: vi.fn(),
      ask: vi.fn(() => Promise.resolve(null)),
      openFile: vi.fn(() => Promise.resolve()),
      isFile: () => Promise.resolve(true),
      platform: 'linux',
    },
    caller: {
      terminal: (id) => (id === 't-1' ? { id, projectId: 'p1' } : undefined),
      projects: () => [{ id: 'p1', name: 'Shop', rootPath: '/work/shop' }],
      activeProjectId: () => 'p1',
      findByPath: () => undefined,
      realpath: () => Promise.resolve(null),
      platform: 'linux',
    },
    describeTerminal: (id) => (id === 't-1' ? 'dev · Shop' : undefined),
    plugins: {
      sources: () => sources,
      onDidChange: (l) => pluginsChanged.event(() => l()),
      call: pluginCall,
      setProblems: vi.fn(),
    },
    askPolicy,
    cli: vi.fn(() => Promise.resolve({ ok: true, output: '' })),
    logger,
    ...(o.resources ? { resources: o.resources } : {}),
  };
  const hub = new McpHub(deps);
  hubs.push(hub);
  const setSources = (next: PluginToolSource[]) => {
    sources = next;
    pluginsChanged.fire();
  };
  const call = (name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) =>
    hub.callTool(name, args, { sessionId: 's', terminalHeader: 't-1', signal });
  return { hub, deps, pluginCall, askPolicy, setSources, call, token: () => token, settings: () => settings };
}

describe('McpHub', () => {
  it('starts the server with a stored token and reports its state', async () => {
    const { hub, token } = setup();
    await hub.start();
    const state = hub.state();
    expect(state.status).toMatchObject({ enabled: true, error: null, sessions: 0 });
    expect(state.status.port).toBeGreaterThan(0);
    expect(token()).toMatch(/^[\w-]{32}$/);
    expect(state.tools.map((t) => t.name)).toContain('oxy_capabilities');
    expect(state.tools.find((t) => t.name === 'db_drop')).toMatchObject({ policy: 'ask', listed: true });
  });

  it('routes plugin tools with the caller context and logs the call without arguments', async () => {
    const { call, pluginCall, hub } = setup();
    const result = await call('db_query', { sql: 'select secret' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'rows: 3' }] });
    expect(pluginCall).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'acme.db',
        name: 'db_query',
        context: { terminalId: 't-1', projectId: 'p1' },
        timeoutMs: 1000,
      }),
    );
    const [entry] = hub.state().log;
    expect(entry).toMatchObject({ tool: 'db_query', source: 'Database', caller: 'dev · Shop', outcome: 'ok' });
    expect(JSON.stringify(hub.state().log)).not.toContain('secret');
  });

  it('asks before tools with the ask policy', async () => {
    const denied = setup({ answer: 'deny' });
    const r = await denied.call('db_drop');
    expect(r).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The user did not allow db_drop this time.' }],
    });
    expect(denied.pluginCall).not.toHaveBeenCalled();
    expect(denied.askPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'db_drop', source: 'Database', caller: 'dev · Shop' }),
    );
    expect(denied.hub.state().log[0]).toMatchObject({ outcome: 'denied' });

    const always = setup({ answer: 'always' });
    await always.call('db_drop');
    expect(always.pluginCall).toHaveBeenCalled();
    expect(always.settings()['mcp.tools.policy']).toEqual({ db_drop: 'allow' });

    const nobody = setup({ answer: null });
    expect((await nobody.call('db_drop')).content[0]).toEqual({
      type: 'text',
      text: "db_drop needs the user's permission, and nobody answered in time.",
    });
  });

  it('times out and cancels calls', async () => {
    const slow = setup({ call: () => new Promise(() => undefined) });
    expect(await slow.call('db_query')).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'db_query did not finish within 1 s.' }],
    });
    const cancel = new AbortController();
    const pending = slow.call('db_query', {}, cancel.signal);
    cancel.abort();
    expect((await pending).content[0]).toEqual({ type: 'text', text: 'Cancelled.' });
    expect(slow.hub.state().log[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('notifies clients once per real change of the tool list', async () => {
    const notify = vi.spyOn(McpHttpServer.prototype, 'notifyToolsChanged');
    const { setSources, deps, hub } = setup();
    const original = deps.plugins.sources();
    // A reload: removed and added again at once → nothing changed.
    setSources([]);
    setSources(original);
    await new Promise((r) => setTimeout(r, 300));
    expect(notify).not.toHaveBeenCalled();
    setSources([]);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(hub.state().tools.some((t) => t.name === 'db_query')).toBe(false);
  });

  it('turns tools off and back on through the settings', async () => {
    const { hub, deps, call } = setup();
    await deps.updateSettings({ 'mcp.tools.disabled': ['db_query'] });
    expect(hub.state().tools.find((t) => t.name === 'db_query')).toMatchObject({ enabled: false, listed: false });
    expect((await call('db_query')).isError).toBe(true);
    await hub.setPolicy('db_drop', 'deny');
    expect(hub.state().tools.find((t) => t.name === 'db_drop')?.listed).toBe(false);
    await hub.setPolicy('db_drop', null);
    expect(hub.state().tools.find((t) => t.name === 'db_drop')?.policy).toBe('ask');
  });

  it('connects Claude Code at the running port and resets the token', async () => {
    const { hub, deps, token } = setup();
    await hub.start();
    const port = hub.state().status.port!;
    const r = await hub.connectClaude();
    expect(r.ok).toBe(true);
    expect(deps.cli).toHaveBeenCalledWith(expect.arrayContaining(['add', `http://127.0.0.1:${port}/mcp`]));
    const before = token();
    await hub.resetToken();
    expect(token()).not.toBe(before);
    expect(hub.clientConfig().json).toContain(token()!);
  });
});

describe('McpHub resource tools', () => {
  it('lists resource tools only while a project has such resources and briefs the caller', async () => {
    const kinds = new Set<string>();
    const changed = new Emitter<void>();
    const tool: ResourceTool = {
      needs: 'sql',
      definition: { name: 'oxy_db_query', description: 'Runs SQL.', inputSchema: { type: 'object' } },
      logDetail: (args) => `db: ${String(args['query'])}`,
      run: () => 'rows',
    };
    const listTool: ResourceTool = {
      needs: 'any',
      definition: { name: 'oxy_project_resources', description: 'Lists.', inputSchema: { type: 'object' } },
      logDetail: () => undefined,
      run: () => '[]',
    };
    const { hub, call } = setup({
      resources: {
        tools: [tool, listTool],
        kinds: () => kinds,
        onDidChange: (l) => changed.event(() => l()),
        brief: (projectId) => (projectId === 'p1' ? 'Project "Shop" has resources: database "shop-db"' : ''),
      },
    });
    const info = () => hub.state().tools.find((t) => t.name === 'oxy_db_query');
    expect(info()).toMatchObject({ listed: false, problem: expect.stringContaining('SQL database') as unknown });
    kinds.add('sql').add('any');
    changed.fire();
    expect(info()).toMatchObject({ listed: true });
    await call('oxy_db_query', { query: 'SELECT 1' });
    expect(hub.state().log[0]).toMatchObject({ tool: 'oxy_db_query', projectId: 'p1', detail: 'db: SELECT 1' });
    const instructions = (hub as unknown as { instructions(t?: string): string }).instructions.bind(hub);
    expect(instructions('t-1')).toContain('database "shop-db"');
    expect(instructions()).toContain('call oxy_project_resources');
  });
});

describe('McpHub Ensemble endpoint', () => {
  it("serves the resource bridge to Ensemble agents for their task's project, without cwd/project arguments", async () => {
    const seen: unknown[] = [];
    const apiTool: ResourceTool = {
      needs: 'api',
      definition: {
        name: 'oxy_api_request',
        description: 'Calls an API.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, cwd: {}, project: {} } },
      },
      logDetail: () => undefined,
      run: ({ args, caller }) => {
        seen.push({ args, context: caller.context });
        return 'HTTP 200';
      },
    };
    const sqlTool: ResourceTool = {
      ...apiTool,
      needs: 'sql',
      definition: { ...apiTool.definition, name: 'oxy_db_query' },
    };
    const { hub } = setup({
      resources: {
        tools: [apiTool, sqlTool],
        kinds: () => new Set(['api']),
        onDidChange: () => ({ dispose: () => undefined }),
        brief: () => '',
      },
    });
    hub.setEnsemble({
      describe: (token) =>
        token === 'role-token' ? { label: 'Tim · Weather', projectId: 'p2', terminalId: 't-9' } : null,
      tools: () => [{ name: 'oxy_ensemble_context', description: 'Context.', inputSchema: { type: 'object' } }],
      call: () => Promise.resolve('ctx'),
      instructions: () => 'Ensemble',
    });
    await hub.start();
    let session: string | null = null;
    const rpc = async (method: string, params: unknown = {}) => {
      const res = await fetch(hub.ensembleUrl()!, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer role-token',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      session ??= res.headers.get('mcp-session-id');
      return ((await res.json()) as { result: Record<string, unknown> }).result;
    };
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    const { tools } = (await rpc('tools/list')) as { tools: { name: string; inputSchema: { properties: object } }[] };
    expect(tools.map((t) => t.name)).toEqual(['oxy_ensemble_context', 'oxy_api_request']);
    expect(Object.keys(tools[1]!.inputSchema.properties)).toEqual(['path']);
    const result = (await rpc('tools/call', {
      name: 'oxy_api_request',
      arguments: { path: '/weather', project: 'p1' },
    })) as McpToolResult;
    expect(result.content).toEqual([{ type: 'text', text: 'HTTP 200' }]);
    expect(seen).toEqual([{ args: { path: '/weather' }, context: { projectId: 'p2', terminalId: 't-9' } }]);
    expect(hub.state().log[0]).toMatchObject({ tool: 'oxy_api_request', projectId: 'p2' });
  });
});
