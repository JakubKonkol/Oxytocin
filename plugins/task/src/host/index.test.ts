import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentLaunchRequest,
  AgentSnapshot,
  PluginContext,
  PluginView,
  ProjectInfo,
  ViewProvider,
} from '@oxytocin/plugin-api';
import { activate } from './index';
import type { Task } from '../shared/task';

type Model = { task: Task; planWaiting: boolean; project: { id: string } | null };

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
  // A running session the user may choose: "busy" (a Codex session in project p).
  const agents: AgentSnapshot[] = [
    { terminalId: 'busy', projectId: 'p', agentId: 'codex', state: 'idle' } as AgentSnapshot,
  ];
  const agentListeners: ((list: AgentSnapshot[]) => void)[] = [];
  const setState = (terminalId: string, state: AgentSnapshot['state'] | 'exited') => {
    const index = agents.findIndex((a) => a.terminalId === terminalId);
    if (state === 'exited') agents.splice(index, 1);
    else agents[index]!.state = state;
    for (const listener of agentListeners) listener(agents);
  };
  let created = 0;
  const launch = vi.fn((o: AgentLaunchRequest): Promise<{ terminalId: string; reused: boolean; sent: boolean }> => {
    if (o.terminalId) return Promise.resolve({ terminalId: o.terminalId, reused: true, sent: false });
    const terminalId = `t${++created}`;
    agents.push({
      terminalId,
      projectId: o.projectId,
      agentId: o.launchId === 'ai:codex' ? 'codex' : 'claude-code',
      state: 'idle',
    } as AgentSnapshot);
    // A new session starts with its prompt on the command line.
    return Promise.resolve({ terminalId, reused: false, sent: !!o.prompt });
  });
  const launchers = [
    { launchId: 'ai:claude', name: 'Claude Code', kind: 'agent', agent: 'claude' },
    { launchId: 'ai:codex', name: 'Codex CLI', kind: 'agent', agent: 'codex' },
    { launchId: 'ai:profile:glm', name: 'GLM', kind: 'profile', agent: 'claude' },
  ];
  const showNotification = vi.fn((_o: unknown) => Promise.resolve(undefined));
  const sendPrompt = vi.fn(
    (_id: string, _text: string): Promise<{ ok: true } | { ok: false; error: string; pasted?: boolean }> =>
      Promise.resolve({ ok: true }),
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
        listLaunchers: () => Promise.resolve(launchers),
        list: () => Promise.resolve([...agents]),
        onDidChange: (listener: (list: AgentSnapshot[]) => void) => {
          agentListeners.push(listener);
          return { dispose: vi.fn() };
        },
        launch,
        listAccounts: () => Promise.resolve([]),
        sendPrompt,
      },
      terminals: {
        list: () => Promise.resolve(agents.map((a) => ({ id: a.terminalId, status: 'running' }))),
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
  const model = () => request<Model>('model');
  const task = async () => (await model()).task;
  const dispose = () => ctx.subscriptions.forEach((d) => d.dispose());
  return {
    request,
    model,
    task,
    launch,
    sendPrompt,
    showNotification,
    setState,
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

const input = { description: 'Add search', planner: { launchId: 'ai:claude' }, implementer: { launchId: 'ai:codex' } };

/** Claude Code's ExitPlanMode hook request: it stays open until the user decides in Task. */
async function hook(dir: string, taskId: string, plan: string, o: { token?: string; signal?: AbortSignal } = {}) {
  const state = JSON.parse(await readFile(join(dir, 'hook.json'), 'utf8')) as { port: number; token: string };
  const res = await fetch(`http://127.0.0.1:${state.port}/task/exit-plan`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${o.token ?? state.token}`,
      'x-oxytocin-task': taskId,
    },
    body: JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan, planFilePath: '/home/me/.claude/plans/search.md' },
    }),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const body = res.status === 200 ? ((await res.json()) as { hookSpecificOutput: Record<string, string> }) : null;
  return { status: res.status, output: body?.hookSpecificOutput };
}

describe('Task workflow', () => {
  it('follows the active project in a sidebar, clears selection and rejects a stale click', async () => {
    const s = await setup(undefined, { sidebar: true });
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
      await s.request('create', input);
      expect(s.launch.mock.calls.at(-1)?.[0].projectId).toBe('p');
    } finally {
      s.dispose();
    }
  });
  it('plans, implements and reviews in fresh sessions that start with their prompt, and persists the task', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', { ...input, reviewer: { launchId: 'ai:claude' } });
      const taskDir = join(s.dir, 'p', id);
      expect((await s.task()).phase).toBe('planning');
      expect(s.launch.mock.calls[0]![0]).toMatchObject({ reuse: false, addDirs: [taskDir] });
      expect(await readFile(join(taskDir, 'task.md'), 'utf8')).toBe('Add search\n');
      await expect(s.request('implement', id)).rejects.toThrow(/Approve/);
      await s.request('approve', { id, plan: '# Search\nAdd a keyboard shortcut.' });
      const implementer = s.launch.mock.calls.at(-1)![0];
      expect(implementer).toMatchObject({ launchId: 'ai:codex', reuse: false, addDirs: [taskDir] });
      expect(implementer.prompt).toContain(join(taskDir, 'brief.md'));
      expect(implementer.prompt).not.toContain('\n');
      expect(await readFile(join(taskDir, 'brief.md'), 'utf8')).toBe(
        '# Task\n\nAdd search\n\n# Approved plan\n\n# Search\nAdd a keyboard shortcut.\n',
      );
      expect(await s.task()).toMatchObject({ phase: 'implementing', implementer: { terminalId: 't2' } });
      expect((await s.task()).outbox).toBeUndefined();
      expect(s.sendPrompt).not.toHaveBeenCalled();
      await expect(s.request('approve', { id, plan: 'Changed plan' })).rejects.toThrow(/already been approved/);
      await s.request('review', id);
      expect((await s.task()).phase).toBe('reviewing');
      expect(s.launch.mock.calls.at(-1)?.[0]).toMatchObject({ launchId: 'ai:claude', reuse: false });
      expect(s.launch.mock.calls.at(-1)?.[0].prompt).toContain('Do not edit files');
      // Every role has a session of its own.
      expect(new Set(s.launch.mock.results.map((_r, i) => `t${i + 1}`)).size).toBe(3);
      await s.request('done', id);
      const t = await s.task();
      expect(t.phase).toBe('done');
      expect(await readFile(join(taskDir, 'approved-plan.md'), 'utf8')).toBe(t.approvedPlan);
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
  it('types the plan into a chosen busy session as soon as its turn ends, without a retry', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', {
        ...input,
        implementer: { launchId: 'ai:codex', terminalId: 'busy' },
      });
      s.setState('busy', 'working');
      await s.request('approve', { id, plan: 'Fix the bug' });
      expect(s.launch.mock.calls.at(-1)?.[0]).toEqual({ projectId: 'p', launchId: 'ai:codex', terminalId: 'busy' });
      await vi.waitFor(async () =>
        expect((await s.task()).outbox).toMatchObject({
          role: 'implementer',
          waiting: 'It is finishing its current turn.',
        }),
      );
      expect((await s.task()).phase).toBe('implementing');
      expect(s.sendPrompt).not.toHaveBeenCalled();
      s.setState('busy', 'waiting');
      await vi.waitFor(async () =>
        expect((await s.task()).outbox?.waiting).toBe('It waits for an answer in its terminal.'),
      );
      s.setState('busy', 'idle');
      await vi.waitFor(() => expect(s.sendPrompt).toHaveBeenCalledTimes(1));
      expect(s.sendPrompt.mock.calls[0]![0]).toBe('busy');
      expect(s.sendPrompt.mock.calls[0]![1]).toContain('brief.md');
      await vi.waitFor(async () => expect((await s.task()).outbox).toBeUndefined());
      expect((await s.task()).error).toBeUndefined();
    } finally {
      s.dispose();
    }
  });
  it('keeps a prompt the new session could not take at start and delivers it when the agent is ready', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      s.launch.mockImplementationOnce(() => Promise.resolve({ terminalId: 't1', reused: false, sent: false }));
      s.setState('t1', 'working');
      await s.request('approve', { id, plan: 'Fix the bug' });
      expect((await s.task()).outbox).toMatchObject({ role: 'implementer' });
      s.sendPrompt.mockResolvedValueOnce({ ok: false, error: 'A question is open in its terminal.' });
      s.setState('t1', 'idle');
      await vi.waitFor(async () =>
        expect((await s.task()).outbox?.waiting).toBe('A question is open in its terminal.'),
      );
      s.setState('t1', 'idle');
      await vi.waitFor(async () => expect((await s.task()).outbox).toBeUndefined());
      expect(s.sendPrompt).toHaveBeenCalledTimes(2);
    } finally {
      s.dispose();
    }
  });
  it('reports a session that ended before its prompt and opens a new one on retry', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', {
        ...input,
        implementer: { launchId: 'ai:codex', terminalId: 'busy' },
      });
      s.setState('busy', 'working');
      await s.request('approve', { id, plan: 'Fix the bug' });
      s.setState('busy', 'exited');
      await vi.waitFor(async () => expect((await s.task()).error).toMatch(/session ended before it received/));
      expect((await s.task()).outbox).toBeUndefined();
      await s.request('implement', id);
      expect(s.launch.mock.calls.at(-1)?.[0]).toMatchObject({ launchId: 'ai:codex', reuse: false });
      expect(await s.task()).toMatchObject({ phase: 'implementing', implementer: { terminalId: 't2' } });
      expect((await s.task()).error).toBeUndefined();
    } finally {
      s.dispose();
    }
  });
  it('never counts a prompt that reached the input box as undelivered', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', {
        ...input,
        implementer: { launchId: 'ai:codex', terminalId: 'busy' },
      });
      s.sendPrompt.mockResolvedValueOnce({ ok: false, error: 'The agent did not start working.', pasted: true });
      await s.request('approve', { id, plan: 'Fix the bug' });
      await vi.waitFor(async () => expect((await s.task()).error).toMatch(/did not start working/));
      expect((await s.task()).outbox).toBeUndefined();
      expect(s.sendPrompt).toHaveBeenCalledTimes(1);
    } finally {
      s.dispose();
    }
  });
});

describe('Task plan hook', () => {
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
      expect(request.prompt).toContain('Task: Add search');
      const settings = JSON.parse(await readFile(file, 'utf8')) as {
        permissions: { deny: string[] };
        hooks: { PreToolUse: { matcher: string; hooks: { url: string; timeout: number }[] }[] };
      };
      expect(settings.permissions.deny).toContain('Bash(git commit *)');
      expect(settings.permissions.deny[0]).toMatch(/^Edit\(\/\/.*\/repo\/\*\*\)$/);
      expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: 'ExitPlanMode' });
      expect(settings.hooks.PreToolUse[0]!.hooks[0]!.timeout).toBeGreaterThan(24 * 3600);
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

  it('holds Claude in the hook until the user decides: feedback and approval are its answers', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      expect(await hook(s.dir, id, '# Plan\nOne', { token: 'wrong' })).toMatchObject({ status: 401 });
      expect(await hook(s.dir, 'not-a-task', '# Plan')).toMatchObject({ status: 204 });
      expect(await hook(s.dir, '', '# Plan')).toMatchObject({ status: 204 });
      const first = hook(s.dir, id, '# Plan\nOne');
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(true));
      // The task is on screen: no notification on top of it.
      expect(s.showNotification).not.toHaveBeenCalled();
      expect(await s.task()).toMatchObject({
        phase: 'ready',
        plan: '# Plan\nOne',
        source: '/home/me/.claude/plans/search.md',
        versions: [{ status: 'pending', origin: 'hook' }],
      });
      await s.request('revise', { id, feedback: 'Add tests.' });
      const revised = await first;
      expect(revised.output).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(revised.output?.['permissionDecisionReason']).toMatch(/revise the plan[\s\S]*Feedback:\nAdd tests\.$/);
      // Nothing is typed into the terminal.
      expect(s.sendPrompt).not.toHaveBeenCalled();
      expect(await s.task()).toMatchObject({
        phase: 'planning',
        versions: [{ status: 'revised', feedback: 'Add tests.' }],
      });
      expect((await s.model()).planWaiting).toBe(false);
      const second = hook(s.dir, id, '# Plan\nOne\nTests');
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(true));
      expect((await s.task()).versions.map((v) => v.status)).toEqual(['revised', 'pending']);
      await s.request('approve', { id, plan: '# Plan\nOne\nTests' });
      expect((await second).output?.['permissionDecisionReason']).toContain('approved this plan');
      expect((await s.task()).versions.map((v) => v.status)).toEqual(['revised', 'approved']);
      expect(await readFile(join(s.dir, 'p', id, 'brief.md'), 'utf8')).toContain('Tests');
      // An approved task takes no more plans: Claude Code asks in the terminal as usual.
      expect(await hook(s.dir, id, '# Later')).toMatchObject({ status: 204 });
    } finally {
      s.dispose();
    }
  });

  it('types feedback into the planner once Claude stopped waiting in the hook', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      const esc = new AbortController();
      const pending = hook(s.dir, id, '# Plan', { signal: esc.signal }).catch(() => null);
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(true));
      esc.abort();
      await pending;
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(false));
      expect((await s.task()).versions).toMatchObject([{ status: 'pending' }]);
      await s.request('revise', { id, feedback: 'Add tests.' });
      await vi.waitFor(() => expect(s.sendPrompt).toHaveBeenCalledTimes(1));
      expect(s.sendPrompt.mock.calls[0]![0]).toBe('t1');
      expect(s.sendPrompt.mock.calls[0]![1]).toMatch(/ExitPlanMode again\. Feedback: Add tests\.$/);
      await vi.waitFor(async () => expect((await s.task()).outbox).toBeUndefined());
    } finally {
      s.dispose();
    }
  });

  it('answers a rejected or deleted task and records an edited approval as its own version', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      const rejected = hook(s.dir, id, '# Plan');
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(true));
      await s.request('reject', id);
      expect((await rejected).output?.['permissionDecisionReason']).toContain('rejected this plan');
      expect(s.showNotification).not.toHaveBeenCalled();
      expect(await s.task()).toMatchObject({ phase: 'rejected', versions: [{ status: 'rejected' }] });
      await expect(s.request('approve', { id, plan: '# Plan' })).rejects.toThrow(/no longer waiting/);
      const second = await s.request<string>('create', { ...input, description: 'Second' });
      const edited = hook(s.dir, second, '# Draft');
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(true));
      await s.request('approve', { id: second, plan: '# Draft, edited' });
      expect((await edited).output?.['permissionDecisionReason']).toContain('approved this plan');
      expect((await s.task()).versions).toMatchObject([
        { status: 'superseded', origin: 'hook' },
        { status: 'approved', origin: 'edit', plan: '# Draft, edited' },
      ]);
      const third = await s.request<string>('create', { ...input, description: 'Third' });
      const deleted = hook(s.dir, third, '# Draft');
      await vi.waitFor(async () => expect((await s.model()).planWaiting).toBe(true));
      await s.request('delete', third);
      expect((await deleted).output?.['permissionDecisionReason']).toContain('deleted');
    } finally {
      s.dispose();
    }
  });
});

describe('Task plan notification', () => {
  it('tells the user where a plan is when Task is not on screen', async () => {
    const s = await setup(undefined, { sidebar: true });
    try {
      const id = await s.request<string>('create', input);
      s.changeProject('q');
      const pending = hook(s.dir, id, '# Plan').catch(() => null);
      await vi.waitFor(() =>
        expect(s.showNotification).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'A plan is ready for your approval in Task.' }),
        ),
      );
      s.dispose();
      // Closing Task ends the waiting request: Claude Code asks in its terminal.
      await pending;
    } finally {
      s.dispose();
    }
  });
});
