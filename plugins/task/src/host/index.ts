import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSnapshot, PluginContext, PluginView, ProjectInfo } from '@oxytocin/plugin-api';
import { z } from 'zod';
import {
  addVersion,
  briefDocument,
  implementationPrompt,
  MAX_PLAN,
  plannerPrompt,
  reviewPrompt,
  revisionPrompt,
  ROLES,
  TaskInputSchema,
  TaskSchema,
  type RoleName,
  type Task,
  type TaskFiles,
} from '../shared/task';
import {
  decision,
  DECISION_REASONS,
  HOOK_PATH,
  PlanHookServer,
  plannerSettings,
  TASK_VAR,
  taskFolderSettings,
} from './hook';
import { captureClaudePlan, readPlan } from './plans';

const HookStateSchema = z.object({ port: z.number().int().min(0).max(65535), token: z.string().min(32).max(128) });
/** New Claude planning sessions: Opus with high effort, unless an API profile chooses its own model. */
const PLANNER_MODEL = ['--model', 'opus', '--effort', 'high'];
/** How long a queued prompt waits for a session whose agent has not been detected yet before Task gives up. */
const AGENT_START_GRACE_MS = 60_000;

export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
  const views = new Map<PluginView, { selected?: string; shown?: string }>();
  const storeFile = join(ctx.storage.globalDir, 'tasks.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(storeFile, 'utf8'));
  } catch {
    raw = [];
  }
  const stored = z.array(TaskSchema).max(100).safeParse(raw);
  const tasks = stored.success ? stored.data : [];
  const busy = new Set<string>();
  const delivering = new Set<string>();
  const recheck = new Set<string>();
  let disposed = false;
  const taskDir = (t: Task) => join(ctx.storage.projectDir(t.projectId), t.id);
  const files = (t: Task): TaskFiles => ({
    task: join(taskDir(t), 'task.md'),
    plan: join(taskDir(t), 'plan.md'),
    brief: join(taskDir(t), 'brief.md'),
  });
  const hooked = (t: Task) => !!t.hookTerminalId && t.planner.terminalId === t.hookTerminalId;
  /** Claude Code sessions waiting in Task's plan hook for the user's decision, by task id. */
  const held = new Map<string, { resolve: (output: object | undefined) => void }>();
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(tasks);
    writes = writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(ctx.storage.globalDir, { recursive: true });
        await writeFile(`${storeFile}.tmp`, snapshot);
        await rename(`${storeFile}.tmp`, storeFile);
      });
    return writes;
  };
  let active: ProjectInfo | undefined;
  const projectOf = (view: PluginView) => view.projectId ?? active?.id;
  const model = async (projectId: string | undefined, selected?: string) => {
    const task = tasks.find((t) => t.projectId === projectId && (!selected || t.id === selected)) ?? null;
    return {
      project: projectId
        ? { id: projectId, name: (await oxy.projects.list()).find((p) => p.id === projectId)?.name ?? projectId }
        : null,
      tasks: tasks
        .filter((t) => t.projectId === projectId)
        .map((t) => ({ id: t.id, description: t.description.slice(0, 160), phase: t.phase })),
      task,
      /** The planner waits in Task's hook for the decision on the current plan. */
      planWaiting: !!task && held.has(task.id),
      launchers: await oxy.agents.listLaunchers(),
      agents: projectId ? (await oxy.agents.list()).filter((a) => a.projectId === projectId) : [],
      terminals: projectId ? await oxy.terminals.list({ projectId }) : [],
    };
  };
  const push = async () => {
    for (const [view, state] of views) {
      if (!view.visible) continue;
      const projectId = projectOf(view);
      const next = await model(projectId, state.selected);
      if (projectId !== projectOf(view)) continue;
      await view.postMessage({ type: 'model', model: next });
      if (projectId) state.shown = projectId;
      else delete state.shown;
    }
  };
  const pushLater = () => void push().catch((e: unknown) => ctx.log.warn(String(e)));
  let projectEvents = 0;
  ctx.subscriptions.push(
    oxy.projects.onDidChangeActive((project) => {
      projectEvents++;
      active = project;
      for (const [view, state] of views) if (!view.projectId) delete state.selected;
      pushLater();
    }),
  );
  const initialEvents = projectEvents;
  const initial = await oxy.projects.getActive();
  if (projectEvents === initialEvents) active = initial;
  const save = async (t: Task) => {
    t.updatedAt = Date.now();
    await persist();
    await push();
  };
  const requireTask = (projectId: string, raw: unknown) => {
    const id = z.string().uuid().parse(raw);
    const task = tasks.find((t) => t.id === id && t.projectId === projectId);
    if (!task) throw new Error('Task not found in this project.');
    return task;
  };
  const awaitingPlan = (t: Task) => !t.approvedPlan && (t.phase === 'planning' || t.phase === 'ready');
  /** Answers the planner waiting in the plan hook, if one waits. */
  const decide = (t: Task, output: object | undefined) => {
    const waiting = held.get(t.id);
    if (!waiting) return false;
    held.delete(t.id);
    waiting.resolve(output);
    return true;
  };

  // Claude Code hands its finished plan to Task through a PreToolUse hook (see ./hook) and waits there for the
  // user's decision. Port and token survive restarts so planning sessions that are still open keep reaching Task.
  const hookFile = join(ctx.storage.globalDir, 'hook.json');
  const savedHook = HookStateSchema.safeParse(
    await readFile(hookFile, 'utf8')
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null),
  );
  const token = savedHook.success ? savedHook.data.token : randomBytes(24).toString('hex');
  const server = new PlanHookServer(token, async (taskId, input, closed) => {
    const t = tasks.find((task) => task.id === taskId);
    if (!t || !awaitingPlan(t)) return undefined;
    const plan = input.tool_input.plan;
    if (!plan.trim() || plan.length > MAX_PLAN) return undefined;
    // A request that is still open belongs to an earlier plan: Claude Code asks about that one in its terminal.
    decide(t, undefined);
    addVersion(t, {
      plan,
      at: Date.now(),
      origin: 'hook',
      ...(input.tool_input.planFilePath ? { source: input.tool_input.planFilePath } : {}),
    });
    t.phase = 'ready';
    delete t.error;
    // Feedback still waiting to be typed belongs to the plan this one replaces.
    if (t.outbox?.role === 'planner') delete t.outbox;
    const entry = { resolve: (_output: object | undefined) => {} };
    const answer = new Promise<object | undefined>((resolve) => (entry.resolve = resolve));
    held.set(t.id, entry);
    closed.addEventListener('abort', () => {
      // Esc in the terminal, or the session ended: the plan stays in Task; feedback is typed from now on.
      if (held.get(t.id) !== entry) return;
      held.delete(t.id);
      entry.resolve(undefined);
      pushLater();
    });
    await save(t);
    // Someone looking at the task sees the plan arrive; anyone else is told where it is.
    if (![...views.keys()].some((view) => view.visible && projectOf(view) === t.projectId))
      void oxy.ui
        .showNotification({
          level: 'info',
          message: 'A plan is ready for your approval in Task.',
          detail: t.description.slice(0, 120),
          actions: [{ id: 'open', title: 'Open Task' }],
        })
        .then((action) => (action === 'open' ? oxy.ui.openPanel('task.panel', { placement: 'sidebar' }) : undefined))
        .catch(() => undefined);
    return answer;
  });
  let hookUrl: string | undefined;
  try {
    const port = await server.start(savedHook.success ? savedHook.data.port : 0);
    hookUrl = `http://127.0.0.1:${port}${HOOK_PATH}`;
    await mkdir(ctx.storage.globalDir, { recursive: true });
    await writeFile(hookFile, JSON.stringify({ port, token }), { mode: 0o600 });
  } catch (e) {
    ctx.log.warn('Plans finished in Claude Code cannot reach Task; they are read from the plan files.', String(e));
  }
  ctx.subscriptions.push({ dispose: () => void server.stop() });

  /**
   * What a new session of a role starts with besides its prompt. Claude Code gets Task's `--settings` file: read access
   * to Task's folder and, for a planner in plan mode, the plan hook, deny rules and bypass in its Shift+Tab cycle
   * (`hooked`). Other CLIs get Task's folder as an extra directory.
   */
  const sessionLaunch = async (t: Task, name: RoleName, launchId: string) => {
    const launcher = (await oxy.agents.listLaunchers()).find((l) => l.launchId === launchId);
    if (launcher?.agent !== 'claude') return { hooked: false, options: { addDirs: [taskDir(t)] } };
    const project = (await oxy.projects.list()).find((p) => p.id === t.projectId);
    const hooked = name === 'planner' && !!hookUrl && t.planMode && !!project;
    const settings =
      hooked && hookUrl && project
        ? plannerSettings({ projectRoot: project.rootPath, taskDir: taskDir(t), url: hookUrl, token })
        : taskFolderSettings(taskDir(t), name === 'planner');
    const file = join(taskDir(t), name === 'planner' ? 'claude-settings.json' : `claude-${name}-settings.json`);
    await mkdir(taskDir(t), { recursive: true });
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return {
      hooked,
      options: {
        claudeArgs: [
          ...(hooked && launcher.kind !== 'profile' ? PLANNER_MODEL : []),
          ...(hooked ? ['--allow-dangerously-skip-permissions'] : []),
          '--settings',
          file,
        ],
        ...(hooked ? { env: { [TASK_VAR]: t.id } } : {}),
      },
    };
  };

  const capture = async (t: Task, agents: AgentSnapshot[]) => {
    if (!awaitingPlan(t) || hooked(t)) return;
    if (busy.has(t.id)) return;
    busy.add(t.id);
    try {
      let found: { path: string; text: string } | null = null;
      const text = await readPlan(files(t).plan, t.startedAt);
      if (text) found = { path: files(t).plan, text };
      const agent = agents.find((a) => a.terminalId === t.planner.terminalId && a.projectId === t.projectId);
      if (!found && agent?.agentId === 'claude-code' && agent.sessionId) {
        const accounts = await oxy.agents.listAccounts();
        const home = accounts.find((a) => a.agent === 'claude' && a.id === (agent.accountId ?? 'main'))?.home;
        if (home) found = await captureClaudePlan(home, agent.sessionId, t.startedAt);
      }
      if (found && found.text !== t.plan) {
        addVersion(t, { plan: found.text, at: Date.now(), origin: 'capture', source: found.path });
        t.phase = 'ready';
        await save(t);
      }
    } finally {
      busy.delete(t.id);
    }
  };

  const agentOf = async (t: Task, terminalId: string | undefined) =>
    terminalId
      ? (await oxy.agents.list()).find((a) => a.terminalId === terminalId && a.projectId === t.projectId)
      : undefined;
  const queue = (t: Task, role: RoleName, prompt: string) => {
    t.outbox = { role, prompt, at: Date.now() };
  };
  /**
   * Hands a prompt to a role. A role without a running agent gets a fresh session that starts with the prompt on its
   * command line (nothing to wait for); the role's existing session is revealed and the prompt is typed as soon as
   * its agent waits for input (see `deliver`). `prompt` gets whether the session hands its plan over through Task's
   * hook.
   */
  const start = async (t: Task, name: RoleName, prompt: (hooked: boolean) => string) => {
    const role = t[name]!;
    if (role.terminalId && !(await agentOf(t, role.terminalId))) delete role.terminalId;
    if (role.terminalId && ROLES.some((other) => other !== name && t[other]?.terminalId === role.terminalId))
      throw new Error(
        'Choose a separate session for each role so that planning and implementation keep separate contexts.',
      );
    if (t.outbox?.role === name) delete t.outbox;
    delete t.error;
    if (role.terminalId) {
      await oxy.agents.launch({ projectId: t.projectId, launchId: role.launchId, terminalId: role.terminalId });
      queue(t, name, prompt(hooked(t)));
      return;
    }
    const session = await sessionLaunch(t, name, role.launchId);
    const text = prompt(session.hooked);
    const result = await oxy.agents.launch({
      projectId: t.projectId,
      launchId: role.launchId,
      reuse: false,
      prompt: text,
      ...(name === 'planner' ? { planMode: t.planMode } : {}),
      ...session.options,
    });
    role.terminalId = result.terminalId;
    if (name === 'planner') {
      if (session.hooked) t.hookTerminalId = result.terminalId;
      else delete t.hookTerminalId;
    }
    if (!result.sent) queue(t, name, text);
  };

  /** Types a queued prompt once its session's agent waits for input; never over a turn or a question. */
  const deliver = async (t: Task): Promise<void> => {
    const box = t.outbox;
    if (!box || disposed) return;
    // A state change during a delivery is looked at once the delivery is over.
    if (delivering.has(t.id)) {
      recheck.add(t.id);
      return;
    }
    delivering.add(t.id);
    try {
      const role = t[box.role];
      const agent = await agentOf(t, role?.terminalId);
      let waiting: string;
      if (!agent) {
        const running = (await oxy.terminals.list({ projectId: t.projectId })).some(
          (terminal) => terminal.id === role?.terminalId && terminal.status === 'running',
        );
        if (running && Date.now() - box.at < AGENT_START_GRACE_MS) waiting = 'The agent is starting.';
        else {
          if (t.outbox !== box) return;
          delete t.outbox;
          if (role) delete role.terminalId;
          t.error = `The ${box.role}'s session ended before it received the prompt. Retry to open a new session.`;
          await save(t);
          return;
        }
      } else if (agent.state !== 'idle')
        waiting =
          agent.state === 'waiting'
            ? 'It waits for an answer in its terminal.'
            : agent.state === 'working'
              ? 'It is finishing its current turn.'
              : 'The agent is starting.';
      else {
        const result = await oxy.agents.sendPrompt(agent.terminalId, box.prompt);
        if (result.ok || result.pasted) {
          if (t.outbox === box) delete t.outbox;
          if (result.ok) delete t.error;
          else t.error = 'The prompt was typed, but the agent did not start working. Check its terminal.';
          await save(t);
          return;
        }
        waiting = result.error;
      }
      if (box.waiting !== waiting) {
        box.waiting = waiting;
        await save(t);
      }
    } finally {
      delivering.delete(t.id);
    }
    if (recheck.delete(t.id)) await deliver(t);
  };
  const deliverAll = () => {
    for (const t of tasks)
      if (t.outbox) void deliver(t).catch((e: unknown) => ctx.log.warn('Could not hand a prompt over', String(e)));
  };

  const locked = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    if (busy.has(id)) throw new Error('This task is busy. Try again in a moment.');
    busy.add(id);
    try {
      return await action();
    } finally {
      busy.delete(id);
    }
  };
  /** Runs a stage change; a failure to start the agent is kept on the task, the stage stays retryable. */
  const stage = async (t: Task, action: () => Promise<void>) => {
    await locked(t.id, async () => {
      try {
        await action();
      } catch (e) {
        t.error = e instanceof Error ? e.message : String(e);
      }
      await save(t);
    });
    deliverAll();
  };
  const implement = async (t: Task) => {
    await writeFile(files(t).brief, briefDocument(t));
    await start(t, 'implementer', () => implementationPrompt(t, files(t)));
    t.phase = 'implementing';
  };

  ctx.subscriptions.push(
    oxy.ui.registerPanelProvider('task.panel', {
      resolve(view) {
        const state: { selected?: string; shown?: string } = {};
        views.set(view, state);
        const currentProject = async () => {
          const projectId = projectOf(view);
          if (!projectId) throw new Error('Open a project first.');
          if (projectId !== state.shown) {
            await push();
            throw new Error('The active project changed. Check the task and try again.');
          }
          return projectId;
        };
        view.onDidDispose(() => views.delete(view));
        view.onDidChangeVisibility((visible) => {
          if (visible) pushLater();
        });
        view.onRequest('model', async () => {
          const projectId = projectOf(view);
          const next = await model(projectId, state.selected);
          if (projectId === projectOf(view)) {
            if (projectId) state.shown = projectId;
            else delete state.shown;
          }
          return next;
        });
        view.onRequest('select', async (id: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, id);
          state.selected = t.id;
          return model(projectId, t.id);
        });
        view.onRequest('create', async (input: unknown) => {
          const projectId = await currentProject();
          const parsed = TaskInputSchema.parse(input);
          const selected = [parsed.planner, parsed.implementer, parsed.reviewer].flatMap((r) =>
            r?.terminalId ? [r.terminalId] : [],
          );
          if (new Set(selected).size !== selected.length) throw new Error('Choose a separate session for each role.');
          if (tasks.length >= 100) throw new Error('Delete an old task before creating another.');
          const t: Task = {
            ...parsed,
            id: randomUUID(),
            projectId,
            phase: 'planning',
            plan: '',
            versions: [],
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
          tasks.unshift(t);
          state.selected = t.id;
          await mkdir(taskDir(t), { recursive: true });
          await writeFile(files(t).task, `${t.description.trim()}\n`);
          await persist();
          await stage(t, () => start(t, 'planner', (viaHook) => plannerPrompt(t, files(t), viaHook)));
          return t.id;
        });
        view.onRequest('retryPlan', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!awaitingPlan(t)) throw new Error('This task is no longer waiting for a plan.');
          await stage(t, () => start(t, 'planner', (viaHook) => plannerPrompt(t, files(t), viaHook)));
        });
        view.onRequest('revise', async (raw: unknown) => {
          const projectId = await currentProject();
          const input = z.object({ id: z.uuid(), feedback: z.string().trim().min(1).max(8000) }).parse(raw);
          const t = requireTask(projectId, input.id);
          await locked(t.id, async () => {
            if (t.phase !== 'ready' || t.approvedPlan) throw new Error('There is no plan waiting for feedback.');
            // A planner waiting in the hook gets the feedback as its answer; any other one has it typed.
            if (!decide(t, decision(DECISION_REASONS.revise(input.feedback)))) {
              const terminalId = t.planner.terminalId;
              if (!(await agentOf(t, terminalId)))
                throw new Error('The planner session has ended. Retry the planning prompt to open a new session.');
              queue(t, 'planner', revisionPrompt(input.feedback, files(t), hooked(t)));
            }
            const current = t.versions.findLast((v) => v.status === 'pending');
            if (current) {
              current.status = 'revised';
              current.feedback = input.feedback;
            }
            t.phase = 'planning';
            delete t.error;
            await save(t);
            if (t.planner.terminalId) await oxy.terminals.show(t.planner.terminalId, { placement: 'right' });
          });
          deliverAll();
        });
        view.onRequest('reject', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          await locked(t.id, async () => {
            if (!awaitingPlan(t)) throw new Error('This plan can no longer be rejected.');
            decide(t, decision(DECISION_REASONS.rejected));
            const current = t.versions.findLast((v) => v.status === 'pending');
            if (current) current.status = 'rejected';
            if (t.outbox?.role === 'planner') delete t.outbox;
            t.phase = 'rejected';
            delete t.error;
            await save(t);
          });
        });
        view.onRequest('approve', async (raw: unknown) => {
          const projectId = await currentProject();
          const input = z.object({ id: z.uuid(), plan: z.string().trim().min(1).max(MAX_PLAN) }).parse(raw);
          const t = requireTask(projectId, input.id);
          if (t.approvedPlan) throw new Error('This plan has already been approved.');
          if (!awaitingPlan(t)) throw new Error('This task is no longer waiting for a plan.');
          await stage(t, async () => {
            const current = t.versions.at(-1);
            if (current?.status === 'pending' && current.plan.trim() === input.plan) current.status = 'approved';
            else addVersion(t, { plan: input.plan, at: Date.now(), origin: 'edit' }, 'approved');
            t.plan = input.plan;
            t.approvedPlan = input.plan;
            t.approvedAt = Date.now();
            t.phase = 'ready';
            if (t.outbox?.role === 'planner') delete t.outbox;
            decide(t, decision(DECISION_REASONS.approved));
            await writeFile(join(taskDir(t), 'approved-plan.md'), input.plan);
            await persist();
            await implement(t);
          });
        });
        view.onRequest('implement', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!t.approvedPlan || !['ready', 'implementing'].includes(t.phase))
            throw new Error('Approve a plan before starting implementation.');
          await stage(t, () => implement(t));
        });
        view.onRequest('review', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!['implementing', 'reviewing'].includes(t.phase) || !t.reviewer)
            throw new Error('Finish implementation before requesting the configured review.');
          await stage(t, async () => {
            await writeFile(files(t).brief, briefDocument(t));
            await start(t, 'reviewer', () => reviewPrompt(t, files(t)));
            t.phase = 'reviewing';
          });
        });
        view.onRequest('done', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!['implementing', 'reviewing'].includes(t.phase))
            throw new Error('This task has not started implementation.');
          await locked(t.id, async () => {
            t.phase = 'done';
            delete t.outbox;
            delete t.error;
            await save(t);
          });
        });
        view.onRequest('cancelDelivery', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          await locked(t.id, async () => {
            delete t.outbox;
            await save(t);
          });
        });
        view.onRequest('delete', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          await locked(t.id, async () => {
            decide(t, decision(DECISION_REASONS.deleted));
            tasks.splice(tasks.indexOf(t), 1);
            await persist();
            await push();
          });
        });
        view.onRequest('show', async (raw: unknown) => {
          const projectId = await currentProject();
          const input = z.object({ id: z.uuid(), role: z.enum(ROLES) }).parse(raw);
          const t = requireTask(projectId, input.id);
          const id = t[input.role]?.terminalId;
          if (id) await oxy.terminals.show(id, { placement: 'right' });
        });
      },
    }),
    oxy.commands.register('task.show', async () => {
      await oxy.ui.openPanel('task.panel', { placement: 'sidebar' });
    }),
    // Agent states drive queued prompts and the sessions shown in Task.
    oxy.agents.onDidChange(() => {
      if (disposed) return;
      deliverAll();
      if (tasks.length > 0) pushLater();
    }),
  );
  let polling = false;
  const timer = setInterval(() => {
    if (polling || disposed) return;
    deliverAll();
    if (!tasks.some((t) => awaitingPlan(t) && !hooked(t)) && ![...views.keys()].some((view) => view.visible)) return;
    polling = true;
    void (async () => {
      const agents = await oxy.agents.list();
      for (const t of tasks) await capture(t, agents);
      await push();
    })()
      .catch((e: unknown) => ctx.log.warn('Could not refresh Task', String(e)))
      .finally(() => {
        polling = false;
      });
  }, 3000);
  ctx.subscriptions.push({
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      for (const t of tasks) decide(t, undefined);
    },
  });
}
