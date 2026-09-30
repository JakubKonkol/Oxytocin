import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunProfile } from './profiles';
import type { RunSnapshot } from './runner';
import { buildTools, LEGACY_TOOL_NAMES, type RunnerTools } from './tools';

const project = { id: 'p1', name: 'shop', rootPath: '/work/shop', color: '#fff' };
const web: RunProfile = {
  id: 'node:web',
  name: 'web',
  command: 'npm run dev',
  cwd: 'web',
  kind: 'node',
  framework: 'Vite',
  url: 'http://localhost:5173',
  source: 'detected',
};

function setup() {
  let snapshot: RunSnapshot = { profileId: web.id, status: 'idle', ports: [] };
  const start = vi.fn(() => {
    snapshot = { ...snapshot, status: 'starting', startedBy: 'agent' };
    return Promise.resolve(snapshot);
  });
  const waitFor = vi.fn(() => {
    snapshot = { ...snapshot, status: 'running', url: 'http://localhost:5173/', ports: [5173] };
    return Promise.resolve(snapshot);
  });
  const logs = vi.fn(() => ['VITE ready', 'Local: http://localhost:5173/']);
  const answer = vi.fn(() => {
    const { prompt: _answered, ...rest } = snapshot;
    snapshot = rest;
    return Promise.resolve(snapshot);
  });
  const addProfile = vi.fn((_p: unknown, input: { name?: unknown }) =>
    Promise.resolve({ ...web, id: 'custom-1', name: String(input.name), source: 'custom' as const }),
  );
  const resolved: unknown[] = [];
  const port: RunnerTools = {
    resolveProject: (args, context) =>
      (resolved.push(context), args.cwd === '/elsewhere')
        ? Promise.reject(new Error('/elsewhere is not inside a project'))
        : Promise.resolve(project),
    profiles: () => Promise.resolve([web]),
    profile: (_p, id) =>
      id === 'web' || id === web.id ? Promise.resolve(web) : Promise.reject(new Error(`No run profile "${id}"`)),
    snapshot: () => snapshot,
    start,
    restart: () => Promise.resolve(snapshot),
    stop: () => {
      snapshot = { ...snapshot, status: 'stopped' };
      return Promise.resolve(snapshot);
    },
    waitFor,
    logs,
    addProfile,
    answer,
  };
  const setSnapshot = (next: Partial<RunSnapshot>) => (snapshot = { ...snapshot, ...next });
  const tools = buildTools(port);
  const call = (name: string, args: Record<string, unknown>, context?: { projectId?: string }) =>
    tools.find((t) => t.name === name)!.handler(args, context);
  return { call, tools, start, waitFor, logs, addProfile, answer, setSnapshot, resolved };
}

describe('MCP tools', () => {
  it('exposes the runner tools with input schemas', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'run_list_profiles',
      'run_start_profile',
      'run_restart_profile',
      'run_stop_profile',
      'run_get_logs',
      'run_answer_prompt',
      'run_add_profile',
    ]);
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: 'object' });
  });

  it('lists profiles with their status', async () => {
    const { call } = setup();
    const out = JSON.parse(await call('run_list_profiles', { cwd: '/work/shop/web' })) as {
      project: unknown;
      profiles: unknown[];
    };
    expect(out.project).toEqual({ name: 'shop', root: '/work/shop' });
    expect(out.profiles).toEqual([
      {
        id: 'node:web',
        name: 'web',
        framework: 'Vite',
        command: 'npm run dev',
        folder: 'web',
        status: 'idle',
        expectedUrl: 'http://localhost:5173',
      },
    ]);
  });

  it('starts as the agent, waits and reports the URL with the recent output', async () => {
    const s = setup();
    const { call } = s;
    const out = await call('run_start_profile', { profile: 'web', wait_seconds: 500 });
    expect(s.start).toHaveBeenCalledWith(project, web);
    expect(s.waitFor).toHaveBeenCalledWith(project, web.id, expect.any(Function), 120_000);
    expect(out).toContain('"status": "running"');
    expect(out).toContain('"url": "http://localhost:5173/"');
    expect(out).toContain('Local: http://localhost:5173/');
  });

  it('reports a question the app waits on and answers it', async () => {
    const s = setup();
    await expect(s.call('run_answer_prompt', { profile: 'web', answer: 'y' })).rejects.toThrow(/not waiting/);
    s.setSnapshot({ status: 'starting', prompt: { id: 1, text: 'Use a different port? (Y/n)', yesNo: true } });
    const waiting = s.setSnapshot({});
    s.waitFor.mockImplementationOnce(() => Promise.resolve(waiting));
    const listed = await s.call('run_list_profiles', {});
    expect(listed).toContain('"waitingForInput": "Use a different port? (Y/n)"');
    const started = await s.call('run_start_profile', { profile: 'web' });
    expect(started).toContain('waiting for an answer in its terminal');
    const answered = await s.call('run_answer_prompt', { profile: 'web', answer: 'y' });
    expect(s.answer).toHaveBeenCalledWith(project, web.id, 'y');
    expect(answered).toContain('"status": "running"');
    await expect(s.call('run_answer_prompt', { profile: 'web' })).rejects.toThrow(/Pass `answer`/);
  });

  it('stops, returns logs and adds profiles', async () => {
    const s = setup();
    const { call } = s;
    expect(await call('run_stop_profile', { profile: 'web' })).toContain('"status"');
    expect(await call('run_get_logs', { profile: 'node:web', lines: 2 })).toContain('VITE ready');
    expect(s.logs).toHaveBeenCalledWith(project, web.id, 2);
    expect(await call('run_add_profile', { name: 'worker', command: 'node w.js', folder: 'jobs' })).toBe(
      'Added run profile worker (id custom-1) to shop.',
    );
    expect(s.addProfile).toHaveBeenCalledWith(project, {
      name: 'worker',
      command: 'node w.js',
      cwd: 'jobs',
      env: undefined,
    });
  });

  it('turns bad arguments into readable errors', async () => {
    const { call } = setup();
    await expect(call('run_start_profile', {})).rejects.toThrow(/Pass `profile`/);
    await expect(call('run_start_profile', { profile: 'api' })).rejects.toThrow(/No run profile "api"/);
    await expect(call('run_list_profiles', { cwd: '/elsewhere' })).rejects.toThrow(/not inside a project/);
  });
});

describe('caller context', () => {
  it("passes the caller's project from Oxytocin's MCP server to the project resolution", async () => {
    const { call, resolved } = setup();
    await call('run_list_profiles', {}, { projectId: 'p1' });
    expect(resolved).toEqual([{ projectId: 'p1' }]);
  });
});

describe('the manifest', () => {
  it('declares exactly the tools the plugin registers (contributes.mcp)', async () => {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      oxytocin: { permissions: string[]; contributes: { mcp: { prefix: string; tools: unknown[] } } };
    };
    const { tools } = setup();
    expect(pkg.oxytocin.permissions).toContain('mcp.tools');
    expect(pkg.oxytocin.contributes.mcp.prefix).toBe('run');
    expect(pkg.oxytocin.contributes.mcp.tools).toEqual(tools.map(({ handler: _handler, ...definition }) => definition));
  });

  it('keeps the old names for the legacy server', () => {
    const legacy = buildTools({} as RunnerTools, LEGACY_TOOL_NAMES);
    expect(legacy.map((t) => t.name)).toEqual([
      'list_run_profiles',
      'start_run_profile',
      'restart_run_profile',
      'stop_run_profile',
      'get_run_logs',
      'answer_run_prompt',
      'add_run_profile',
    ]);
    expect(legacy.find((t) => t.name === 'restart_run_profile')?.description).toContain('like start_run_profile');
  });
});
