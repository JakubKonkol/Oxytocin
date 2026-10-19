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
      { id: 'p', name: 'First', rootPath: join(dir, 'repo') },
      { id: 'q', name: 'Second', rootPath: join(dir, 'other') },
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
  const launchers = [
    { launchId: 'ai:claude', name: 'Claude Code', kind: 'agent', agent: 'claude' },
    { launchId: 'ai:codex', name: 'Codex CLI', kind: 'agent', agent: 'codex' },
    { launchId: 'ai:profile:glm', name: 'GLM', kind: 'profile', agent: 'claude' },
  ];
  const showNotification = vi.fn((_o: unknown) => Promise.resolve(undefined));
  const sendPrompt = vi.fn((_id: string, _text: string) => Promise.resolve({ ok: true as const }));
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
        listLaunchers: () => Promise.resolve(launchers),
        list: () => Promise.resolve([]),
        launch,
        listAccounts: () => Promise.resolve([]),
        sendPrompt,
      },
      terminals: {
        list: () =>
          Promise.resolve(
            ['busy', ...launch.mock.results.map((_r, i) => `t${i + 1}`)].map((id) => ({ id, status: 'running' })),
          ),
        show: vi.fn(),
      },
      ui: {
        showNotification,
        openPanel: vi.fn(() => Promise.resolve()),
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
    sendPrompt,
    showNotification,
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

describe('Task plan hook', () => {
  const hook = async (dir: string, taskId: string, body: unknown, token?: string) => {
    const state = JSON.parse(await readFile(join(dir, 'hook.json'), 'utf8')) as { port: number; token: string };
    const res = await fetch(`http://127.0.0.1:${state.port}/task/exit-plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token ?? state.token}`,
        'x-oxytocin-task': taskId,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null };
  };
  const exitPlan = (plan: string) => ({
    session_id: 's1',
    hook_event_name: 'PreToolUse',
    tool_name: 'ExitPlanMode',
    tool_input: { plan, planFilePath: '/home/me/.claude/plans/search.md' },
  });
  const input = {
    description: 'Add search',
    planner: { launchId: 'ai:claude' },
    implementer: { launchId: 'ai:codex' },
  };

  it('starts a fresh Claude planner in plan mode with bypass available, its hook and deny rules', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      const request = s.launch.mock.calls[0]![0];
      const file = join(s.dir, 'p', id, 'claude-settings.json');
      expect(request).toMatchObject({
        launchId: 'ai:claude',
        planMode: true,
        reuse: false,
        claudeArgs: ['--model', 'opus', '--effort', 'high', '--allow-dangerously-skip-permissions', '--settings', file],
        env: { OXYTOCIN_TASK_ID: id },
      });
      expect(request.prompt).toContain('finish it with ExitPlanMode');
      const settings = JSON.parse(await readFile(file, 'utf8')) as {
        permissions: { deny: string[] };
        hooks: { PreToolUse: { matcher: string; hooks: { url: string }[] }[] };
      };
      expect(settings.permissions.deny).toContain('Bash(git commit *)');
      expect(settings.permissions.deny[0]).toMatch(/^Edit\(\/\/.*\/repo\/\*\*\)$/);
      expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'ExitPlanMode' });
      expect((await s.task()).hookTerminalId).toBe('t1');
    } finally {
      s.dispose();
    }
  });

  it('gives other planners the plan document and API profiles their own model', async () => {
    const s = await setup();
    try {
      await s.request('create', { ...input, planner: { launchId: 'ai:codex' } });
      expect(s.launch.mock.calls[0]![0]).not.toHaveProperty('claudeArgs');
      expect(s.launch.mock.calls[0]![0].prompt).toContain('plan.md');
      await s.request('create', { ...input, planner: { launchId: 'ai:profile:glm' } });
      expect(s.launch.mock.calls[1]![0].claudeArgs?.slice(0, 1)).toEqual(['--allow-dangerously-skip-permissions']);
    } finally {
      s.dispose();
    }
  });

  it('takes the finished plan, revises it with feedback, keeps the versions and approves the latest', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      expect(await hook(s.dir, id, exitPlan('# Plan\nOne'), 'wrong')).toMatchObject({ status: 401 });
      expect(await hook(s.dir, 'not-a-task', exitPlan('# Plan'))).toMatchObject({ status: 204 });
      expect(await hook(s.dir, '', exitPlan('# Plan'))).toMatchObject({ status: 204 });
      const taken = await hook(s.dir, id, exitPlan('# Plan\nOne'));
      expect(taken.body).toMatchObject({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
      });
      expect(JSON.stringify(taken.body)).toContain('do not call ExitPlanMode');
      // The task is on screen: no notification on top of it.
      expect(s.showNotification).not.toHaveBeenCalled();
      expect(await s.task()).toMatchObject({
        phase: 'ready',
        plan: '# Plan\nOne',
        source: '/home/me/.claude/plans/search.md',
        versions: [{ status: 'pending', origin: 'hook' }],
      });
      await s.request('revise', { id, feedback: 'Add tests.' });
      expect(s.sendPrompt).toHaveBeenCalledWith('t1', 'Add tests.');
      expect(await s.task()).toMatchObject({
        phase: 'planning',
        versions: [{ status: 'revised', feedback: 'Add tests.' }],
      });
      await hook(s.dir, id, exitPlan('# Plan\nOne\nTests'));
      const t = await s.task();
      expect(t.versions.map((v) => v.status)).toEqual(['revised', 'pending']);
      await s.request('approve', { id, plan: '# Plan\nOne\nTests' });
      expect((await s.task()).versions.map((v) => v.status)).toEqual(['revised', 'approved']);
      expect(s.launch.mock.calls.at(-1)?.[0].prompt).toContain('Tests');
      // An approved task takes no more plans: Claude Code asks in the terminal as usual.
      expect(await hook(s.dir, id, exitPlan('# Later'))).toMatchObject({ status: 204 });
    } finally {
      s.dispose();
    }
  });

  it('rejects a plan and records an edited approval as its own version', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      await hook(s.dir, id, exitPlan('# Plan'));
      await s.request('reject', id);
      expect(s.showNotification).not.toHaveBeenCalled();
      expect(await s.task()).toMatchObject({ phase: 'rejected', versions: [{ status: 'rejected' }] });
      await expect(s.request('approve', { id, plan: '# Plan' })).rejects.toThrow(/no longer waiting/);
      const second = await s.request<string>('create', { ...input, description: 'Second' });
      await hook(s.dir, second, exitPlan('# Draft'));
      await s.request('approve', { id: second, plan: '# Draft, edited' });
      expect((await s.task()).versions).toMatchObject([
        { status: 'superseded', origin: 'hook' },
        { status: 'approved', origin: 'edit', plan: '# Draft, edited' },
      ]);
    } finally {
      s.dispose();
    }
  });
});

describe('Task plan notification', () => {
  it('tells the user where a plan is when Task is not on screen', async () => {
    const s = await setup(undefined, { sidebar: true });
    try {
      const id = await s.request<string>('create', {
        description: 'Add search',
        planner: { launchId: 'ai:claude' },
        implementer: { launchId: 'ai:codex' },
      });
      s.changeProject('q');
      const state = JSON.parse(await readFile(join(s.dir, 'hook.json'), 'utf8')) as { port: number; token: string };
      await fetch(`http://127.0.0.1:${state.port}/task/exit-plan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${state.token}`, 'x-oxytocin-task': id },
        body: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'ExitPlanMode',
          tool_input: { plan: '# Plan' },
        }),
      });
      await vi.waitFor(() =>
        expect(s.showNotification).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'A plan is ready for your approval in Task.' }),
        ),
      );
    } finally {
      s.dispose();
    }
  });
});
