import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { activate, KICKOFF_MS, PLAN_SETTLE_MS } from './index';
import type { Task } from '../shared/task';

type Model = { task: Task; planFile: string | null; stalled: string | null; project: { id: string } | null };

/** A plan with Task's outline, as a planner writes it. */
const PLAN = `# Search

## Summary
Add a search field.

## Steps

### [ ] 1. Add the field
Files: \`src/search.ts\`

Render it.

### [ ] 2. Test it
Files: \`src/search.test.ts\`

## Verification
- [ ] \`npm test\`
- [ ] Try it
`;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

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
    /** Runs `action` and waits until Task has read the plan files and updated its view once more. */
    refreshed: async (action: () => void) => {
      const before = postMessage.mock.calls.length;
      action();
      await vi.waitFor(() => expect(postMessage.mock.calls.length).toBeGreaterThan(before));
    },
    changeProject: (id?: string) => {
      active = id ? ({ id, name: id === 'p' ? 'First' : 'Second' } as ProjectInfo) : undefined;
      changed(active);
    },
  };
}

const input = { description: 'Add search', planner: { launchId: 'ai:claude' }, implementer: { launchId: 'ai:codex' } };

describe('Task workflow', () => {
  it('reports a new session that does not start on its prompt until it is seen working', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await setup();
    try {
      await s.request('create', input);
      expect((await s.model()).stalled).toBeNull();
      vi.setSystemTime(Date.now() + KICKOFF_MS);
      // Claude opened with the prompt but waits for input: the user is told to look at its terminal.
      expect((await s.model()).stalled).toBe('planner');
      s.setState('t1', 'working');
      s.setState('t1', 'idle');
      expect((await s.model()).stalled).toBeNull();
      // A session that is still starting (a trust question, a slow start) is reported the same way.
      const second = await s.request<string>('create', { ...input, description: 'Second' });
      s.setState('t2', 'starting');
      vi.setSystemTime(Date.now() + KICKOFF_MS);
      expect((await s.request<Model>('select', second)).stalled).toBe('planner');
      await s.request('reject', second);
      expect((await s.model()).stalled).toBeNull();
    } finally {
      s.dispose();
      vi.useRealTimers();
    }
  });
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
  it('plans, implements and reviews through the files in .oxy/tasks and removes them when the task is done', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', { ...input, reviewer: { launchId: 'ai:claude' } });
      const tasks = join(s.dir, 'repo', '.oxy', 'tasks');
      const taskDir = join(tasks, id);
      const planFile = join(taskDir, 'plan.md');
      expect((await s.task()).phase).toBe('planning');
      expect((await s.model()).planFile).toBe(planFile);
      // One line that names the files; how to plan is in the skill. Nothing but Task's settings is added.
      const planner = s.launch.mock.calls[0]![0];
      expect(planner).toEqual({
        projectId: 'p',
        launchId: 'ai:claude',
        reuse: false,
        prompt: expect.any(String) as string,
        claudeArgs: ['--settings', join(taskDir, 'claude-planner-settings.json')],
      });
      expect(planner.prompt).not.toContain('\n');
      expect(planner.prompt).not.toContain('Add search');
      for (const path of [join(taskDir, 'raw.task.json'), planFile, join(tasks, 'skills', 'plan.md')])
        expect(planner.prompt).toContain(path);
      expect(JSON.parse(await readFile(join(taskDir, 'raw.task.json'), 'utf8'))).toMatchObject({
        version: 1,
        id,
        description: 'Add search',
      });
      expect(await readFile(join(tasks, '.gitignore'), 'utf8')).toBe('*\n');
      expect(await readFile(join(tasks, 'skills', 'plan.md'), 'utf8')).toContain('### [ ] 1.');
      const allowed = async (role: string) =>
        (
          JSON.parse(await readFile(join(taskDir, `claude-${role}-settings.json`), 'utf8')) as {
            permissions: { allow: string[]; deny?: string[] };
          }
        ).permissions;
      expect((await allowed('planner')).allow).toEqual([
        expect.stringMatching(/^Read\(\/\/.*\/repo\/\.oxy\/tasks\/\*\*\)$/),
        expect.stringMatching(new RegExp(`^Edit\\(//.*/repo/\\.oxy/tasks/${id}/\\*\\*\\)$`)),
      ]);
      expect(await allowed('planner')).not.toHaveProperty('deny');

      await expect(s.request('implement', id)).rejects.toThrow(/Approve/);
      // The planner writes the plan file and ends its turn: that is how the plan arrives.
      await writeFile(planFile, PLAN);
      s.setState('t1', 'idle');
      await vi.waitFor(async () => expect((await s.task()).phase).toBe('ready'));
      expect(await s.task()).toMatchObject({
        plan: PLAN,
        source: planFile,
        versions: [{ status: 'pending', origin: 'capture' }],
      });
      // The task is on screen: no notification on top of it.
      expect(s.showNotification).not.toHaveBeenCalled();

      await s.request('approve', { id, plan: PLAN.trim() });
      const implementer = s.launch.mock.calls.at(-1)![0];
      expect(implementer).toEqual({
        projectId: 'p',
        launchId: 'ai:codex',
        reuse: false,
        prompt: expect.any(String) as string,
      });
      expect(implementer.prompt).toContain(planFile);
      expect(implementer.prompt).toContain(join(tasks, 'skills', 'implement.md'));
      expect(implementer.prompt).not.toContain('\n');
      expect(await readFile(planFile, 'utf8')).toBe(PLAN);
      expect(await s.task()).toMatchObject({ phase: 'implementing', implementer: { terminalId: 't2' } });
      expect((await s.task()).outbox).toBeUndefined();
      expect(s.sendPrompt).not.toHaveBeenCalled();
      await expect(s.request('approve', { id, plan: 'Changed plan' })).rejects.toThrow(/already been approved/);

      // The implementer ticks a step and a check in the plan file: Task shows the progress.
      await writeFile(
        planFile,
        PLAN.replace('### [ ] 1.', '### [x] 1.').replace('- [ ] `npm test`', '- [x] `npm test`'),
      );
      s.setState('t2', 'idle');
      await vi.waitFor(async () =>
        expect((await s.task()).progress).toEqual({ steps: [true, false], checks: [true, false] }),
      );
      // A retry leaves the plan file, with its ticks, as it is.
      await s.request('implement', id);
      expect(await readFile(planFile, 'utf8')).toContain('### [x] 1.');

      await s.request('review', id);
      expect((await s.task()).phase).toBe('reviewing');
      const reviewer = s.launch.mock.calls.at(-1)![0];
      expect(reviewer).toMatchObject({
        launchId: 'ai:claude',
        reuse: false,
        claudeArgs: ['--settings', join(taskDir, 'claude-reviewer-settings.json')],
      });
      expect((await allowed('reviewer')).allow).toEqual([expect.stringMatching(/^Read\(/)]);
      expect(reviewer.prompt).toContain(join(tasks, 'skills', 'review.md'));
      expect(reviewer.prompt).toContain('Do not edit files');
      expect(await readFile(planFile, 'utf8')).toContain('### [x] 1.');
      // Every role has a session of its own.
      expect(new Set(s.launch.mock.calls.map((call) => call[0].launchId)).size).toBe(2);
      expect((await s.task()).reviewer?.terminalId).toBe('t3');

      // The last ticks are read before the files leave the project; nothing of Task stays in it.
      await writeFile(planFile, PLAN.replaceAll('[ ]', '[x]'));
      await s.request('done', id);
      const t = await s.task();
      expect(t).toMatchObject({ phase: 'done', progress: { steps: [true, true], checks: [true, true] } });
      expect((await s.model()).planFile).toBeNull();
      expect(await exists(join(s.dir, 'repo', '.oxy'))).toBe(false);
      const restored = await setup(s.dir);
      try {
        expect(await restored.task()).toMatchObject({ approvedPlan: PLAN.trim(), progress: t.progress });
      } finally {
        restored.dispose();
      }
    } finally {
      s.dispose();
    }
  });

  it('gives agents other than Claude Code nothing but the prompt', async () => {
    const s = await setup();
    try {
      await s.request('create', { ...input, planner: { launchId: 'ai:codex' } });
      const request = s.launch.mock.calls[0]![0];
      expect(Object.keys(request).sort()).toEqual(['launchId', 'projectId', 'prompt', 'reuse']);
      expect(request.prompt).toContain('plan.md');
    } finally {
      s.dispose();
    }
  });

  it('waits for a planner that is still writing, then takes the plan once it has settled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      const planFile = join(s.dir, 'repo', '.oxy', 'tasks', id, 'plan.md');
      s.setState('t1', 'working');
      await writeFile(planFile, PLAN);
      await s.refreshed(() => s.setState('t1', 'working'));
      expect((await s.task()).phase).toBe('planning');
      // A planner whose turn does not seem to end cannot keep its plan from the user.
      vi.setSystemTime(Date.now() + PLAN_SETTLE_MS + 1000);
      s.setState('t1', 'working');
      await vi.waitFor(async () => expect((await s.task()).phase).toBe('ready'));
    } finally {
      s.dispose();
      vi.useRealTimers();
    }
  });

  it('types feedback into the planner, takes the rewritten file as the next version and approves an edited plan', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      const taskDir = join(s.dir, 'repo', '.oxy', 'tasks', id);
      const planFile = join(taskDir, 'plan.md');
      // A plan without Task's outline is still a plan.
      await writeFile(planFile, 'Just do it.');
      s.setState('t1', 'idle');
      await vi.waitFor(async () => expect((await s.task()).phase).toBe('ready'));
      await s.request('revise', { id, feedback: 'Use the format.' });
      await vi.waitFor(() => expect(s.sendPrompt).toHaveBeenCalledTimes(1));
      expect(s.sendPrompt.mock.calls[0]![0]).toBe('t1');
      expect(s.sendPrompt.mock.calls[0]![1]).toContain(planFile);
      expect(s.sendPrompt.mock.calls[0]![1]).toMatch(/Feedback: Use the format\.$/);
      await vi.waitFor(async () => expect((await s.task()).outbox).toBeUndefined());
      // Nothing new in the file yet: the plan that got feedback is not taken again.
      await s.refreshed(() => s.setState('t1', 'idle'));
      expect(await s.task()).toMatchObject({
        phase: 'planning',
        versions: [{ status: 'revised', feedback: 'Use the format.' }],
      });
      await writeFile(planFile, PLAN);
      s.setState('t1', 'idle');
      await vi.waitFor(async () => expect((await s.task()).phase).toBe('ready'));
      expect((await s.task()).versions.map((v) => v.status)).toEqual(['revised', 'pending']);
      // The implementer reads exactly what was approved, also when it was edited in Task.
      const edited = PLAN.replace('Add the field', 'Add the search field').trim();
      await s.request('approve', { id, plan: edited });
      expect(await readFile(planFile, 'utf8')).toBe(`${edited}\n`);
      expect((await s.task()).versions).toMatchObject([
        { status: 'revised' },
        { status: 'superseded', origin: 'capture' },
        { status: 'approved', origin: 'edit', plan: edited },
      ]);
      // An approved task takes no more plans from the file.
      await writeFile(planFile, `${edited}\n\nLater thoughts.\n`);
      await s.refreshed(() => s.setState('t1', 'idle'));
      expect((await s.task()).approvedPlan).toBe(edited);
      expect((await s.task()).versions).toHaveLength(3);
    } finally {
      s.dispose();
    }
  });

  it('removes the files of a rejected or deleted task and keeps those of the other tasks', async () => {
    const s = await setup();
    try {
      const tasks = join(s.dir, 'repo', '.oxy', 'tasks');
      const first = await s.request<string>('create', input);
      const second = await s.request<string>('create', { ...input, description: 'Second' });
      await writeFile(join(tasks, second, 'plan.md'), PLAN);
      s.setState('t2', 'idle');
      await vi.waitFor(async () => expect((await s.task()).phase).toBe('ready'));
      await s.request('reject', second);
      expect(await s.task()).toMatchObject({ phase: 'rejected', versions: [{ status: 'rejected' }] });
      await expect(s.request('approve', { id: second, plan: PLAN })).rejects.toThrow(/no longer waiting/);
      expect((await readdir(tasks)).sort()).toEqual(['.gitignore', first, 'skills'].sort());
      // Something else in .oxy (a Code Map) is not Task's to remove.
      await mkdir(join(s.dir, 'repo', '.oxy', 'code-map'));
      await s.request('delete', first);
      expect(await readdir(join(s.dir, 'repo', '.oxy'))).toEqual(['code-map']);
    } finally {
      s.dispose();
    }
  });

  it('reports a plan file that is too large instead of taking it', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      await writeFile(join(s.dir, 'repo', '.oxy', 'tasks', id, 'plan.md'), 'x'.repeat(100_000));
      s.setState('t1', 'idle');
      await vi.waitFor(async () => expect((await s.task()).error).toMatch(/larger than 90 KB/));
      expect((await s.task()).phase).toBe('planning');
    } finally {
      s.dispose();
    }
  });

  it('brings the task files back for a prompt when they were removed', async () => {
    const s = await setup();
    try {
      const id = await s.request<string>('create', input);
      await s.request('approve', { id, plan: PLAN.trim() });
      await rm(join(s.dir, 'repo', '.oxy'), { recursive: true });
      await s.request('implement', id);
      const taskDir = join(s.dir, 'repo', '.oxy', 'tasks', id);
      expect(await readFile(join(taskDir, 'plan.md'), 'utf8')).toBe(PLAN);
      expect(await exists(join(taskDir, 'raw.task.json'))).toBe(true);
      expect(await exists(join(s.dir, 'repo', '.oxy', 'tasks', 'skills', 'implement.md'))).toBe(true);
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
      expect(s.sendPrompt.mock.calls[0]![1]).toContain('plan.md');
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

describe('Task plan notification', () => {
  it('tells the user where a plan is when Task is not on screen', async () => {
    const s = await setup(undefined, { sidebar: true });
    try {
      const id = await s.request<string>('create', input);
      s.changeProject('q');
      await writeFile(join(s.dir, 'repo', '.oxy', 'tasks', id, 'plan.md'), PLAN);
      s.setState('t1', 'idle');
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
