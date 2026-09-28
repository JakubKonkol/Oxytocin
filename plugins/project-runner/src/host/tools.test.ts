import { describe, expect, it, vi } from 'vitest';
import type { RunProfile } from './profiles';
import type { RunSnapshot } from './runner';
import { buildTools, type RunnerTools } from './tools';

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
  const addProfile = vi.fn((_p: unknown, input: { name?: unknown }) =>
    Promise.resolve({ ...web, id: 'custom-1', name: String(input.name), source: 'custom' as const }),
  );
  const port: RunnerTools = {
    resolveProject: (args) =>
      args.cwd === '/elsewhere'
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
  };
  const tools = buildTools(port);
  const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handler(args);
  return { call, tools, start, waitFor, logs, addProfile };
}

describe('MCP tools', () => {
  it('exposes the runner tools with input schemas', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'list_run_profiles',
      'start_run_profile',
      'restart_run_profile',
      'stop_run_profile',
      'get_run_logs',
      'add_run_profile',
    ]);
    for (const t of tools) expect(t.inputSchema).toMatchObject({ type: 'object' });
  });

  it('lists profiles with their status', async () => {
    const { call } = setup();
    const out = JSON.parse(await call('list_run_profiles', { cwd: '/work/shop/web' })) as {
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
    const out = await call('start_run_profile', { profile: 'web', wait_seconds: 500 });
    expect(s.start).toHaveBeenCalledWith(project, web);
    expect(s.waitFor).toHaveBeenCalledWith(project, web.id, expect.any(Function), 120_000);
    expect(out).toContain('"status": "running"');
    expect(out).toContain('"url": "http://localhost:5173/"');
    expect(out).toContain('Local: http://localhost:5173/');
  });

  it('stops, returns logs and adds profiles', async () => {
    const s = setup();
    const { call } = s;
    expect(await call('stop_run_profile', { profile: 'web' })).toContain('"status"');
    expect(await call('get_run_logs', { profile: 'node:web', lines: 2 })).toContain('VITE ready');
    expect(s.logs).toHaveBeenCalledWith(project, web.id, 2);
    expect(await call('add_run_profile', { name: 'worker', command: 'node w.js', folder: 'jobs' })).toBe(
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
    await expect(call('start_run_profile', {})).rejects.toThrow(/Pass `profile`/);
    await expect(call('start_run_profile', { profile: 'api' })).rejects.toThrow(/No run profile "api"/);
    await expect(call('list_run_profiles', { cwd: '/elsewhere' })).rejects.toThrow(/not inside a project/);
  });
});
