import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchRequest, PluginContext, PluginView, ProjectInfo, ViewProvider } from '@oxytocin/plugin-api';
import { activate } from './index';
import type { Task } from '../shared/task';

async function setup(dir?: string, options: { sidebar?: boolean; noProject?: boolean } = {}) {
  dir ??= await mkdtemp(join(tmpdir(), 'oxy-task-host-'));
  let provider: ViewProvider | undefined;
  let active = options.noProject ? undefined : ({ id: 'p', name: 'First' } as ProjectInfo);
  let changed: (p: ProjectInfo | undefined) => void = () => {};
  const postMessage = vi.fn(() => Promise.resolve(true));
  const list = vi.fn(() =>
    Promise.resolve([
      { id: 'p', name: 'First' },
      { id: 'q', name: 'Second' },
    ]),
  );
  const requests = new Map<string, (p: unknown) => unknown>();
  const launch = vi.fn(
    (_options: AgentLaunchRequest): Promise<{ terminalId: string; reused: boolean; sent: boolean }> =>
      Promise.resolve({
        terminalId: `t${launch.mock.calls.length}`,
        reused: false,
        sent: true,
      }),
  );
  const ctx = {
    subscriptions: [],
    storage: { globalDir: dir, projectDir: (id: string) => join(dir, id) },
    log: { warn: vi.fn() },
    oxy: {
      projects: {
        getActive: () => Promise.resolve(active),
        list,
        onDidChangeActive: (handler: typeof changed) => {
          changed = handler;
          return { dispose: vi.fn() };
        },
      },
      agents: {
        listLaunchers: () => Promise.resolve([]),
        list: () => Promise.resolve([]),
        launch,
        listAccounts: () => Promise.resolve([]),
      },
      terminals: { list: () => Promise.resolve([{ id: 'busy', status: 'running' }]), show: vi.fn() },
      ui: {
        registerPanelProvider: (_id: string, p: ViewProvider) => {
          provider = p;
          return { dispose: vi.fn() };
        },
      },
      commands: { register: () => ({ dispose: vi.fn() }) },
    },
  } as unknown as PluginContext;
  await activate(ctx);
  await provider!.resolve({
    ...(options.sidebar ? {} : { projectId: 'p' }),
    visible: true,
    postMessage,
    onDidDispose: vi.fn(),
    onDidChangeVisibility: vi.fn(),
    onRequest: (method: string, handler: (p: unknown) => unknown) => requests.set(method, handler),
  } as unknown as PluginView);
  const request = async <T = unknown>(method: string, value?: unknown): Promise<T> =>
    requests.get(method)!(value) as Promise<T>;
  await request('model');
  const task = async () => (await request<{ task: Task }>('model')).task;
  const dispose = () => ctx.subscriptions.forEach((d) => d.dispose());
  return {
    request,
    task,
    launch,
    dir,
    dispose,
    postMessage,
    list,
    changeProject: (id?: string) => {
      active = id ? ({ id, name: id === 'p' ? 'First' : 'Second' } as ProjectInfo) : undefined;
      changed(active);
    },
  };
}

describe('Task workflow', () => {
  it('follows the active project in a sidebar, clears selection and rejects a stale click', async () => {
    const s = await setup(undefined, { sidebar: true });
    const input = { description: 'Search', planner: { launchId: 'ai:claude' }, implementer: { launchId: 'ai:codex' } };
    try {
      expect(await s.request('model')).toMatchObject({ project: { id: 'p', name: 'First' } });
      const first = await s.request('create', input);
      const second = await s.request('create', { ...input, description: 'Second task' });
      await s.request('select', first);
      s.changeProject('q');
      await expect(s.request('delete', first)).rejects.toThrow('The active project changed');
      expect(await s.request('model')).toMatchObject({ project: { id: 'q' }, task: null, tasks: [] });
      await s.request('create', input);
      expect(s.launch.mock.calls.at(-1)?.[0].projectId).toBe('q');
      s.changeProject('p');
      expect(await s.request('model')).toMatchObject({ project: { id: 'p' }, task: { id: second } });
      expect(s.postMessage).toHaveBeenCalled();
    } finally {
      s.dispose();
    }
  });
  it('shows an empty model without a project and refuses mutations', async () => {
    const s = await setup(undefined, { sidebar: true, noProject: true });
    try {
      expect(await s.request('model')).toMatchObject({ project: null, tasks: [], agents: [], terminals: [] });
      await expect(s.request('create', {})).rejects.toThrow('Open a project first.');
    } finally {
      s.dispose();
    }
  });
  it('keeps a workspace view tied to its own project', async () => {
    const s = await setup();
    try {
      s.changeProject('q');
      expect(await s.request('model')).toMatchObject({ project: { id: 'p' } });
      await s.request('create', {
        description: 'Search',
        planner: { launchId: 'ai:claude' },
        implementer: { launchId: 'ai:codex' },
      });
      expect(s.launch.mock.calls.at(-1)?.[0].projectId).toBe('p');
    } finally {
      s.dispose();
    }
  });
  it('requires approval, freezes the document, sends one prompt per stage and persists across activation', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', {
        description: 'Add search',
        planner: { launchId: 'ai:claude' },
        implementer: { launchId: 'ai:codex' },
        reviewer: { launchId: 'ai:claude' },
      });
      expect((await s.task()).phase).toBe('planning');
      expect(s.launch).toHaveBeenCalledTimes(1);
      await expect(s.request('implement', id)).rejects.toThrow(/Approve/);
      await s.request('approve', { id, plan: '# Search\nAdd a keyboard shortcut.' });
      expect((await s.task()).phase).toBe('implementing');
      expect(s.launch.mock.calls.at(-1)?.[0]).toMatchObject({
        launchId: 'ai:codex',
      });
      expect(s.launch.mock.calls.at(-1)?.[0].prompt).toContain('Add a keyboard shortcut.');
      await expect(s.request('approve', { id, plan: 'Changed plan' })).rejects.toThrow(/already been approved/);
      await s.request('review', id);
      expect((await s.task()).phase).toBe('reviewing');
      expect(s.launch.mock.calls.at(-1)?.[0]).toMatchObject({
        launchId: 'ai:claude',
        reuse: false,
      });
      expect(s.launch.mock.calls.at(-1)?.[0].prompt).toContain('Do not edit files');
      await s.request('done', id);
      const t = await s.task();
      expect(t.phase).toBe('done');
      expect(await readFile(join(s.dir, 'p', id, 'approved-plan.md'), 'utf8')).toBe(t.approvedPlan);
      const restored = await setup(s.dir);
      try {
        expect((await restored.task()).approvedPlan).toBe(t.approvedPlan);
      } finally {
        restored.dispose();
      }
    } finally {
      s.dispose();
    }
  });
  it('keeps the approved plan when delivery is blocked and allows an explicit retry without reapproval', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', {
        description: 'Fix search',
        planner: { launchId: 'ai:claude' },
        implementer: { launchId: 'ai:codex' },
      });
      s.launch.mockResolvedValueOnce({ terminalId: 'busy', reused: true, sent: false });
      await s.request('approve', { id, plan: 'Fix the bug' });
      expect(await s.task()).toMatchObject({
        phase: 'ready',
        approvedPlan: 'Fix the bug',
        implementer: { terminalId: 'busy' },
      });
      await s.request('implement', id);
      expect((await s.task()).phase).toBe('implementing');
      expect(s.launch.mock.calls.at(-1)?.[0]).toMatchObject({ terminalId: 'busy' });
    } finally {
      s.dispose();
    }
  });
});
