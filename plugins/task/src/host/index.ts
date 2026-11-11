import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSnapshot, PluginContext, PluginView, ProjectInfo } from '@oxytocin/plugin-api';
import { z } from 'zod';
import { planProgress, sameProgress } from '../shared/plan';
import {
  addVersion,
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
import { claudeSettings, prepareTaskFiles, readPlanFile, removeTaskFiles, taskFiles } from './files';

/** How long a queued prompt waits for a session whose agent has not been detected yet before Task gives up. */
const AGENT_START_GRACE_MS = 60_000;
/** After this long without starting on its prompt, a new session is shown as stalled (its terminal needs a look). */
export const KICKOFF_MS = 30_000;
/**
 * A plan file written while the planner is still in its turn is taken once it has not changed for this long: the
 * planner may be rewriting it, and a planner whose turn never seems to end must not keep its plan from the user.
 */
export const PLAN_SETTLE_MS = 10_000;
/** How often the plan files are read: for a new plan while one is awaited, for ticks during implementation. */
export const POLL_MS = 3000;
const PLAN_TOO_LARGE = `The plan file is larger than ${MAX_PLAN / 1000} KB. Ask the planner for a shorter plan.`;

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
  const capturing = new Set<string>();
  const delivering = new Set<string>();
  const recheck = new Set<string>();
  let disposed = false;
  /** The project folder the task's files live in (`.oxy/tasks/<id>`); `null` once the project was removed. */
  const rootOf = async (t: Task) => (await oxy.projects.list()).find((p) => p.id === t.projectId)?.rootPath ?? null;
  const requireRoot = async (t: Task) => {
    const root = await rootOf(t);
    if (!root) throw new Error("The task's project is no longer in Oxytocin.");
    return root;
  };
  /**
   * New sessions that got their prompt on the command line and have not been seen working on it (or asking
   * something) yet, by task id. A session still idle after `KICKOFF_MS` is reported instead of looking healthy.
   */
  const kickoffs = new Map<string, { role: RoleName; terminalId: string; at: number }>();
  const now = () => Date.now();
  const noticeStarts = (agents: AgentSnapshot[]) => {
    for (const [id, kickoff] of kickoffs) {
      const state = agents.find((a) => a.terminalId === kickoff.terminalId)?.state;
      if (state === 'working' || state === 'waiting') kickoffs.delete(id);
    }
  };
  /** The role whose new session has not started on its prompt, when it waits for input or is still starting. */
  const stalled = (t: Task, agents: AgentSnapshot[]): RoleName | null => {
    const kickoff = kickoffs.get(t.id);
    if (!kickoff || t[kickoff.role]?.terminalId !== kickoff.terminalId) return null;
    if (t.phase === 'done' || t.phase === 'rejected') return null;
    if (now() - kickoff.at < KICKOFF_MS) return null;
    const state = agents.find((a) => a.terminalId === kickoff.terminalId)?.state;
    return state === 'idle' || state === 'starting' ? kickoff.role : null;
  };
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
    const projects = projectId ? await oxy.projects.list() : [];
    const project = projects.find((p) => p.id === projectId);
    const agents = projectId ? (await oxy.agents.list()).filter((a) => a.projectId === projectId) : [];
    noticeStarts(agents);
    return {
      project: projectId ? { id: projectId, name: project?.name ?? projectId } : null,
      tasks: tasks
        .filter((t) => t.projectId === projectId)
        .map((t) => ({ id: t.id, description: t.description.slice(0, 160), phase: t.phase })),
      task,
      /** Where the open task's plan file is, while the task has files in the project. */
      planFile:
        task && project?.rootPath && task.phase !== 'done' && task.phase !== 'rejected'
          ? taskFiles(project.rootPath, task.id).plan
          : null,
      /** A role whose new session has not started on its prompt (see `KICKOFF_MS`). */
      stalled: task ? stalled(task, agents) : null,
      launchers: await oxy.agents.listLaunchers(),
      agents,
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
  const inProgress = (t: Task) => t.phase === 'implementing' || t.phase === 'reviewing';

  /**
   * What a new session of a role starts with besides its prompt. The task's files are inside the project, so no agent
   * needs an extra directory; Claude Code gets a `--settings` file that lets it read them, and write the task's own
   * folder, without a permission question.
   */
  const sessionOptions = async (name: RoleName, launchId: string, root: string, files: TaskFiles) => {
    const launcher = (await oxy.agents.listLaunchers()).find((l) => l.launchId === launchId);
    if (launcher?.agent !== 'claude') return {};
    const file = join(files.dir, `claude-${name}-settings.json`);
    await writeFile(file, `${JSON.stringify(claudeSettings(root, files, name), null, 2)}\n`);
    return { claudeArgs: ['--settings', file] };
  };

  /**
   * Takes the planner's plan file as the next version of the plan. The file is the only way a plan arrives, whatever
   * the agent: nothing is read from its conversation and nothing depends on its plan mode.
   */
  const capture = async (t: Task, agents: AgentSnapshot[]) => {
    // Reading never keeps the user's actions waiting: a task that is being changed is looked at next time.
    const wanted = () => awaitingPlan(t) && !busy.has(t.id) && tasks.includes(t);
    if (!wanted() || capturing.has(t.id)) return;
    capturing.add(t.id);
    try {
      const root = await rootOf(t);
      if (!root) return;
      const path = taskFiles(root, t.id).plan;
      const found = await readPlanFile(path);
      if (!found || !wanted()) return;
      if ('tooLarge' in found) {
        if (t.error !== PLAN_TOO_LARGE) {
          t.error = PLAN_TOO_LARGE;
          await save(t);
        }
        return;
      }
      if (found.text.trim() === t.plan.trim()) return;
      const state = agents.find((a) => a.terminalId === t.planner.terminalId && a.projectId === t.projectId)?.state;
      if (state === 'working' && now() - found.mtimeMs < PLAN_SETTLE_MS) return;
      addVersion(t, { plan: found.text, at: now(), origin: 'capture', source: path });
      t.phase = 'ready';
      delete t.error;
      // Feedback still waiting to be typed belongs to the plan this one replaces.
      if (t.outbox?.role === 'planner') delete t.outbox;
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
    } finally {
      capturing.delete(t.id);
    }
  };

  /** Reads what the implementer ticked in the plan file; `true` when it changed. */
  const readProgress = async (t: Task): Promise<boolean> => {
    const root = await rootOf(t);
    const found = root ? await readPlanFile(taskFiles(root, t.id).plan) : null;
    const progress = found && 'text' in found ? planProgress(found.text) : null;
    if (!progress || !inProgress(t) || sameProgress(progress, t.progress)) return false;
    t.progress = progress;
    return true;
  };
  /** A closed task leaves no files in the project (nor in Task's storage, where Task 0.4 kept them). */
  const cleanup = async (t: Task) => {
    const root = await rootOf(t);
    if (root)
      await removeTaskFiles(root, t.id).catch((e: unknown) =>
        ctx.log.warn('Could not remove the task files', String(e)),
      );
    await rm(join(ctx.storage.projectDir(t.projectId), t.id), { recursive: true, force: true }).catch(() => undefined);
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
   * its agent waits for input (see `deliver`). `plan` is the approved plan, for the roles that read it.
   */
  const start = async (
    t: Task,
    name: RoleName,
    prompt: (files: TaskFiles) => string,
    plan?: { text: string; replace: boolean },
  ) => {
    const role = t[name]!;
    if (role.terminalId && !(await agentOf(t, role.terminalId))) delete role.terminalId;
    if (role.terminalId && ROLES.some((other) => other !== name && t[other]?.terminalId === role.terminalId))
      throw new Error(
        'Choose a separate session for each role so that planning and implementation keep separate contexts.',
      );
    if (t.outbox?.role === name) delete t.outbox;
    delete t.error;
    const root = await requireRoot(t);
    const files = await prepareTaskFiles(root, t, plan);
    const text = prompt(files);
    if (role.terminalId) {
      await oxy.agents.launch({ projectId: t.projectId, launchId: role.launchId, terminalId: role.terminalId });
      queue(t, name, text);
      return;
    }
    const result = await oxy.agents.launch({
      projectId: t.projectId,
      launchId: role.launchId,
      reuse: false,
      prompt: text,
      ...(await sessionOptions(name, role.launchId, root, files)),
    });
    role.terminalId = result.terminalId;
    if (!result.sent) queue(t, name, text);
    else kickoffs.set(t.id, { role: name, terminalId: result.terminalId, at: now() });
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
  const plan = (t: Task) => stage(t, () => start(t, 'planner', plannerPrompt));
  /** `replace`: the plan file becomes exactly what the user approved; a retry keeps the file with its ticks. */
  const implement = async (t: Task, replace: boolean) => {
    await start(t, 'implementer', (files) => implementationPrompt(t, files), { text: t.approvedPlan ?? '', replace });
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
          await persist();
          await plan(t);
          return t.id;
        });
        view.onRequest('retryPlan', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!awaitingPlan(t)) throw new Error('This task is no longer waiting for a plan.');
          await plan(t);
        });
        view.onRequest('revise', async (raw: unknown) => {
          const projectId = await currentProject();
          const input = z.object({ id: z.uuid(), feedback: z.string().trim().min(1).max(8000) }).parse(raw);
          const t = requireTask(projectId, input.id);
          await locked(t.id, async () => {
            if (t.phase !== 'ready' || t.approvedPlan) throw new Error('There is no plan waiting for feedback.');
            if (!(await agentOf(t, t.planner.terminalId)))
              throw new Error('The planner session has ended. Retry the planning prompt to open a new session.');
            const files = await prepareTaskFiles(await requireRoot(t), t, { text: t.plan, replace: false });
            queue(t, 'planner', revisionPrompt(input.feedback, files));
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
            const current = t.versions.findLast((v) => v.status === 'pending');
            if (current) current.status = 'rejected';
            if (t.outbox?.role === 'planner') delete t.outbox;
            t.phase = 'rejected';
            delete t.error;
            kickoffs.delete(t.id);
            await cleanup(t);
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
            delete t.progress;
            if (t.outbox?.role === 'planner') delete t.outbox;
            await persist();
            await implement(t, true);
          });
        });
        view.onRequest('implement', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!t.approvedPlan || !['ready', 'implementing'].includes(t.phase))
            throw new Error('Approve a plan before starting implementation.');
          await stage(t, () => implement(t, false));
        });
        view.onRequest('review', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!inProgress(t) || !t.reviewer)
            throw new Error('Finish implementation before requesting the configured review.');
          await stage(t, async () => {
            await start(t, 'reviewer', (files) => reviewPrompt(t, files), {
              text: t.approvedPlan ?? '',
              replace: false,
            });
            t.phase = 'reviewing';
          });
        });
        view.onRequest('done', async (raw: unknown) => {
          const projectId = await currentProject();
          const t = requireTask(projectId, raw);
          if (!inProgress(t)) throw new Error('This task has not started implementation.');
          await locked(t.id, async () => {
            // The last ticks stay with the task; its files leave the project.
            await readProgress(t).catch(() => false);
            t.phase = 'done';
            delete t.outbox;
            delete t.error;
            kickoffs.delete(t.id);
            await cleanup(t);
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
            tasks.splice(tasks.indexOf(t), 1);
            kickoffs.delete(t.id);
            await cleanup(t);
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
    oxy.agents.onDidChange((agents) => {
      if (disposed) return;
      noticeStarts(agents);
      deliverAll();
      // A turn that just ended may have left a plan or new ticks: no need to wait for the timer.
      if (tasks.some(usesFiles)) pollLater();
      else if (tasks.length > 0) pushLater();
    }),
  );
  const usesFiles = (t: Task) => awaitingPlan(t) || inProgress(t);
  let polling = false;
  let again = false;
  /** Reads the plan files: a new plan while one is awaited, the implementer's ticks afterwards. */
  const poll = async (): Promise<void> => {
    if (disposed) return;
    if (polling) {
      again = true;
      return;
    }
    polling = true;
    try {
      const agents = await oxy.agents.list();
      let ticked = false;
      for (const t of [...tasks]) {
        await capture(t, agents);
        if (inProgress(t) && !busy.has(t.id)) ticked = (await readProgress(t)) || ticked;
      }
      if (ticked) await persist();
      await push();
    } finally {
      polling = false;
    }
    if (again) {
      again = false;
      await poll();
    }
  };
  const pollLater = () => void poll().catch((e: unknown) => ctx.log.warn('Could not refresh Task', String(e)));
  const timer = setInterval(() => {
    if (disposed) return;
    deliverAll();
    if (tasks.some(usesFiles) || [...views.keys()].some((view) => view.visible)) pollLater();
  }, POLL_MS);
  ctx.subscriptions.push({
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  });
}
