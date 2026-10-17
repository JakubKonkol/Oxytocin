import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSnapshot, PluginContext, PluginView } from '@oxytocin/plugin-api';
import { z } from 'zod';
import {
  implementationPrompt,
  plannerPrompt,
  reviewPrompt,
  TaskInputSchema,
  TaskSchema,
  type Task,
  type Role,
} from '../shared/task';
import { captureClaudePlan, readPlan } from './plans';

export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
  const views = new Map<PluginView, string | undefined>();
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
  let disposed = false;
  const taskDir = (t: Task) => join(ctx.storage.projectDir(t.projectId), t.id);
  const document = (t: Task) => join(taskDir(t), 'plan.md');
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
  const model = async (projectId: string, selected?: string) => ({
    tasks: tasks
      .filter((t) => t.projectId === projectId)
      .map((t) => ({ id: t.id, description: t.description.slice(0, 160), phase: t.phase })),
    task: tasks.find((t) => t.projectId === projectId && (!selected || t.id === selected)) ?? null,
    launchers: await oxy.agents.listLaunchers(),
    agents: (await oxy.agents.list()).filter((a) => a.projectId === projectId),
    terminals: await oxy.terminals.list({ projectId }),
  });
  const push = async () => {
    for (const [view, selected] of views)
      if (view.visible && view.projectId)
        await view.postMessage({ type: 'model', model: await model(view.projectId, selected) });
  };
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
  const capture = async (t: Task, agents: AgentSnapshot[]) => {
    if (t.approvedPlan) return;
    if (t.phase !== 'planning' && t.phase !== 'ready') return;
    if (busy.has(t.id)) return;
    busy.add(t.id);
    try {
      let found: { path: string; text: string } | null = null;
      const text = await readPlan(document(t), t.startedAt);
      if (text) found = { path: document(t), text };
      const agent = agents.find((a) => a.terminalId === t.planner.terminalId && a.projectId === t.projectId);
      if (!found && agent?.agentId === 'claude-code' && agent.sessionId) {
        const accounts = await oxy.agents.listAccounts();
        const home = accounts.find((a) => a.agent === 'claude' && a.id === (agent.accountId ?? 'main'))?.home;
        if (home) found = await captureClaudePlan(home, agent.sessionId, t.startedAt);
      }
      if (found && found.text !== t.plan) {
        t.plan = found.text;
        t.source = found.path;
        t.phase = 'ready';
        await save(t);
      }
    } finally {
      busy.delete(t.id);
    }
  };
  const send = async (t: Task, role: Role, prompt: string, planMode = false) => {
    // Saved terminal ids may no longer exist after a restart or after the user closed a terminal.
    if (
      role.terminalId &&
      !(await oxy.terminals.list({ projectId: t.projectId })).some(
        (terminal) => terminal.id === role.terminalId && terminal.status === 'running',
      )
    )
      delete role.terminalId;
    const previousRoles = role === t.planner ? [] : role === t.implementer ? [t.planner] : [t.planner, t.implementer];
    if (role.terminalId && previousRoles.some((r) => r.terminalId === role.terminalId))
      throw new Error(
        'Choose a separate terminal for each role so planning and implementation keep separate contexts.',
      );
    const reuse = !role.newSession && !previousRoles.some((r) => r.launchId === role.launchId);
    const result = await oxy.agents.launch({
      projectId: t.projectId,
      launchId: role.launchId,
      reuse,
      ...(role.terminalId ? { terminalId: role.terminalId } : {}),
      prompt,
      planMode,
    });
    role.terminalId = result.terminalId;
    if (result.sent) delete t.error;
    else t.error = result.error ?? 'Open the agent terminal and retry when it is ready.';
    return result.sent;
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
  ctx.subscriptions.push(
    oxy.ui.registerPanelProvider('task.panel', {
      resolve(view) {
        const projectId = view.projectId;
        if (!projectId) throw new Error('Open Task in a project.');
        views.set(view, undefined);
        view.onDidDispose(() => views.delete(view));
        view.onDidChangeVisibility((visible) => {
          if (visible) void push().catch((e: unknown) => ctx.log.warn(String(e)));
        });
        view.onRequest('model', () => model(projectId, views.get(view)));
        view.onRequest('select', async (id: unknown) => {
          const t = requireTask(projectId, id);
          views.set(view, t.id);
          return model(projectId, t.id);
        });
        view.onRequest('create', async (input: unknown) => {
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
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
          tasks.unshift(t);
          views.set(view, t.id);
          await mkdir(taskDir(t), { recursive: true });
          await persist();
          await locked(t.id, async () => {
            try {
              await send(t, t.planner, plannerPrompt(t, document(t)), t.planMode);
            } catch (e) {
              t.error = String(e);
            }
            await save(t);
          });
          return t.id;
        });
        view.onRequest('retryPlan', async (raw: unknown) => {
          const t = requireTask(projectId, raw);
          if (t.approvedPlan) throw new Error('This plan has already been approved.');
          await locked(t.id, async () => {
            await send(t, t.planner, plannerPrompt(t, document(t)), t.planMode);
            await save(t);
          });
        });
        view.onRequest('approve', async (raw: unknown) => {
          const input = z.object({ id: z.uuid(), plan: z.string().trim().min(1).max(180_000) }).parse(raw);
          const t = requireTask(projectId, input.id);
          await locked(t.id, async () => {
            if (t.approvedPlan) throw new Error('This plan has already been approved.');
            t.plan = input.plan;
            t.approvedPlan = input.plan;
            t.approvedAt = Date.now();
            t.phase = 'ready';
            await writeFile(join(taskDir(t), 'approved-plan.md'), input.plan);
            await persist();
            if (await send(t, t.implementer, implementationPrompt(t))) t.phase = 'implementing';
            await save(t);
          });
        });
        view.onRequest('implement', async (raw: unknown) => {
          const t = requireTask(projectId, raw);
          if (t.phase !== 'ready' || !t.approvedPlan) throw new Error('Approve a plan before starting implementation.');
          await locked(t.id, async () => {
            if (await send(t, t.implementer, implementationPrompt(t))) t.phase = 'implementing';
            await save(t);
          });
        });
        view.onRequest('review', async (raw: unknown) => {
          const t = requireTask(projectId, raw);
          if (t.phase !== 'implementing' || !t.reviewer)
            throw new Error('Finish implementation before requesting the configured review.');
          await locked(t.id, async () => {
            if (await send(t, t.reviewer!, reviewPrompt(t))) t.phase = 'reviewing';
            await save(t);
          });
        });
        view.onRequest('done', async (raw: unknown) => {
          const t = requireTask(projectId, raw);
          if (!['implementing', 'reviewing'].includes(t.phase))
            throw new Error('This task has not started implementation.');
          await locked(t.id, async () => {
            t.phase = 'done';
            delete t.error;
            await save(t);
          });
        });
        view.onRequest('delete', async (raw: unknown) => {
          const t = requireTask(projectId, raw);
          await locked(t.id, async () => {
            tasks.splice(tasks.indexOf(t), 1);
            await persist();
            await push();
          });
        });
        view.onRequest('show', async (raw: unknown) => {
          const input = z.object({ id: z.uuid(), role: z.enum(['planner', 'implementer', 'reviewer']) }).parse(raw);
          const t = requireTask(projectId, input.id);
          const id = t[input.role]?.terminalId;
          if (id) await oxy.terminals.show(id, { placement: 'right' });
        });
      },
    }),
    oxy.commands.register('task.show', async () => {
      const project = await oxy.projects.getActive();
      if (!project) throw new Error('Open a project first.');
      await oxy.ui.openPanel('task.panel', { projectId: project.id });
    }),
  );
  let polling = false;
  const timer = setInterval(() => {
    if (polling || disposed) return;
    if (
      !tasks.some((t) => !t.approvedPlan && (t.phase === 'planning' || t.phase === 'ready')) &&
      ![...views.keys()].some((view) => view.visible)
    )
      return;
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
    },
  });
}
