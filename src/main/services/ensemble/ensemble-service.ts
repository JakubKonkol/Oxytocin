import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import {
  type AgentLive,
  type CliStatus,
  type EnsembleAgent,
  type EnsembleChange,
  type EnsembleChecks,
  type EnsembleCli,
  type EnsembleRecord,
  type EnsembleRun,
  type EnsembleTask,
  EnsembleTaskSchema,
  type FinishAction,
  isActiveStatus,
  type Submission,
  type WorktreeInfo,
} from '@shared/domain/ensemble';
import type { McpToolResult } from '@shared/domain/mcp';
import type { Settings } from '@shared/domain/settings';
import type { TerminalInfo } from '@shared/domain/terminal';
import { CLI_INFO } from '@shared/ensemble/clis';
import { type ConductorEvent, type Effect, initialRun, reduce, validateTask } from '@shared/ensemble/conductor';
import { agentContext, runReport } from '@shared/ensemble/context';
import { taskFromTemplate, slugId } from '@shared/ensemble/presets';
import { systemPromptText } from '@shared/ensemble/prompts';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import type { WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { commandLine, quoteArg, type ShellKind } from '@shared/utils/shell-command';
import type { CreateOptions } from '../terminals/terminal-service';
import type { CreateTerminalRequest } from '@shared/domain/terminal';
import { buildLaunch, customValues, type LaunchContext, readsPromptFile, sessionName } from './adapters';
import { ENSEMBLE_TOOLS, runEnsembleTool } from './ensemble-tools';
import { EnsembleStore } from './ensemble-store';
import { deliver } from './prompt-delivery';

type WsCall = <M extends Extract<keyof WorkspaceHostMethods, string>>(
  method: M,
  params: Parameters<WorkspaceHostMethods[M]>[0],
  opts?: { timeoutMs?: number },
) => Promise<Awaited<ReturnType<WorkspaceHostMethods[M]>>>;

export interface EnsembleServiceDeps {
  dir: string;
  logger: Logger;
  settings(): Settings;
  projects: { get(id: string): { id: string; name: string; rootPath: string } | undefined };
  terminals: {
    create(req: CreateTerminalRequest, opts?: CreateOptions): Promise<TerminalInfo>;
    get(id: string): TerminalInfo | undefined;
    kill(id: string, force?: boolean): Promise<void>;
    close(id: string): Promise<void>;
    onDidUpdate(listener: (info: TerminalInfo) => void): Disposable;
    onDidRemove(listener: (id: string) => void): Disposable;
  };
  agents: {
    list(): AgentInfoWithTerminal[];
    onDidUpdate(listener: (list: AgentInfoWithTerminal[]) => void): Disposable;
  };
  pty: {
    paste(id: string, text: string, submit: boolean): Promise<unknown>;
    write(id: string, data: string): Promise<unknown>;
    text(id: string): Promise<string>;
    onActivity(listener: (e: { id: string; lastOutputAt: number }) => void): Disposable;
  };
  workspace: WsCall;
  mcp: {
    url(): string | null;
    status(): { enabled: boolean; running: boolean; error: string | null };
    endSessions(token: string): void;
  };
  /** PATH lookup and `--version` of a command (cached by the caller). */
  detect(command: string): Promise<{ installed: boolean; version?: string; problem?: string }>;
  bridgeEnabled(): boolean;
  notify(o: {
    title: string;
    body: string;
    level: 'info' | 'warning' | 'error';
    projectId: string;
    taskId: string;
  }): void;
  platform: NodeJS.Platform;
  now?: () => number;
  /** Background timer period (ms); 0 disables it (tests call `tick()`). */
  tickMs?: number;
}

/** One running agent CLI (by terminal). */
interface LiveAgent {
  taskId: string;
  agentId: string;
  terminalId: string;
  cli: EnsembleCli;
  token: string;
  startedAt: number;
  seenAgent: boolean;
  firstSeenAt?: number;
  lastOutputAt: number;
  lastWorkingAt: number;
  reported?: AgentLive;
  delivering: boolean;
  secretFiles: string[];
}

interface CommandRun {
  taskId: string;
  stageId?: string;
  resolve(r: { exitCode: number; output: string }): void;
}

const MAX_RENDERER_EVENTS = 600;
const PROGRESS_INTERVAL_MS = 4000;
/** Prompts on screen that must never receive a typed message. */
const BLOCKING_PROMPT =
  /(do you trust|trust (this|the) (folder|directory|files|workspace)|press enter to (continue|confirm)|log ?in to|sign in|select (a|an) (login|auth)|\[y\/n\]|\(y\/n\))/i;

const projectSlug = (name: string) => slugId(name, [], 'project');

/** Ensemble (Plan 03): tasks run by a team of AI agents. One conductor per task; effects run here. */
export class EnsembleService implements Disposable {
  private readonly store: EnsembleStore;
  private readonly records = new Map<string, EnsembleRecord>();
  private readonly live = new Map<string, LiveAgent>();
  private readonly tokens = new Map<string, LiveAgent>();
  private readonly commands = new Map<string, CommandRun>();
  private readonly waiters = new Map<string, (answer: string | null) => void>();
  private readonly lastProgress = new Map<string, number>();
  /** Every terminal Ensemble created (agents, commands) while it exists. */
  private readonly owned = new Set<string>();
  private readonly disposables = new DisposableStore();
  private readonly changeEmitter = new Emitter<EnsembleRecord>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly removeEmitter = new Emitter<{ taskId: string; projectId: string }>();
  readonly onDidRemove = this.removeEmitter.event;
  private readonly publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private agentsByTerminal = new Map<string, AgentInfoWithTerminal>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  readonly ready: Promise<void>;

  constructor(private readonly deps: EnsembleServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new EnsembleStore(deps.dir, deps.logger);
    this.ready = this.load();
    this.disposables.add(
      deps.agents.onDidUpdate((list) => {
        this.agentsByTerminal = new Map(list.map((a) => [a.terminalId, a]));
        this.refreshStates();
      }),
    );
    this.disposables.add(deps.terminals.onDidUpdate((info) => this.onTerminal(info)));
    this.disposables.add(deps.terminals.onDidRemove((id) => this.onTerminalRemoved(id)));
    this.disposables.add(
      deps.pty.onActivity((e) => {
        const a = this.live.get(e.id);
        if (a) a.lastOutputAt = e.lastOutputAt;
      }),
    );
    const tickMs = deps.tickMs ?? 1000;
    if (tickMs > 0) this.timer = setInterval(() => this.tick(), tickMs);
  }

  // ── records ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    for (const record of await this.store.loadAll()) {
      this.records.set(record.task.id, record);
      // Runs that were active when Oxytocin closed are interrupted (never resumed automatically).
      if (isActiveStatus(record.run.status)) this.dispatch(record.task.id, { type: 'interrupted' });
    }
  }

  list(projectId?: string): EnsembleRecord[] {
    return [...this.records.values()]
      .filter((r) => !projectId || r.task.projectId === projectId)
      .sort((a, b) => b.task.updatedAt - a.task.updatedAt)
      .map((r) => this.forRenderer(r));
  }

  get(taskId: string): EnsembleRecord | undefined {
    return this.records.get(taskId);
  }

  private require(taskId: string): EnsembleRecord {
    const r = this.records.get(taskId);
    if (!r) throw new OxyError('NOT_FOUND', `Ensemble task ${taskId} not found`);
    return r;
  }

  /** The record as the renderer gets it (the latest events only). */
  private forRenderer(r: EnsembleRecord): EnsembleRecord {
    if (r.run.events.length <= MAX_RENDERER_EVENTS) return r;
    return { task: r.task, run: { ...r.run, events: r.run.events.slice(-MAX_RENDERER_EVENTS) } };
  }

  private publish(taskId: string): void {
    if (this.publishTimers.has(taskId)) return;
    this.publishTimers.set(
      taskId,
      setTimeout(() => {
        this.publishTimers.delete(taskId);
        const r = this.records.get(taskId);
        if (r) this.changeEmitter.fire(this.forRenderer(r));
      }, 150),
    );
  }

  private put(record: EnsembleRecord): void {
    this.records.set(record.task.id, record);
    this.store.save(record);
    this.publish(record.task.id);
  }

  async create(o: {
    projectId: string;
    templateId: string;
    title?: string;
    description?: string;
  }): Promise<EnsembleRecord> {
    await this.ready;
    if (!this.deps.projects.get(o.projectId)) throw new OxyError('NOT_FOUND', 'Project not found');
    const id = slugId(
      `${(o.title ?? 'task').slice(0, 16)}-${randomBytes(3).toString('hex')}`,
      this.records.keys(),
      'task',
    );
    const task = taskFromTemplate(o.templateId, {
      id,
      projectId: o.projectId,
      ...(o.title ? { title: o.title } : {}),
      ...(o.description ? { description: o.description } : {}),
      now: this.now(),
    });
    const record: EnsembleRecord = { task, run: initialRun(task) };
    this.put(record);
    return this.forRenderer(record);
  }

  duplicate(taskId: string): EnsembleRecord {
    const source = this.require(taskId).task;
    const id = slugId(`${source.title.slice(0, 16)}-${randomBytes(3).toString('hex')}`, this.records.keys(), 'task');
    const task: EnsembleTask = {
      ...structuredClone(source),
      id,
      title: `${source.title} (copy)`.slice(0, 120),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const record: EnsembleRecord = { task, run: initialRun(task) };
    this.put(record);
    return this.forRenderer(record);
  }

  /** Saves the builder's task. Running tasks only take a new title. */
  save(input: unknown): EnsembleRecord {
    const parsed = EnsembleTaskSchema.safeParse(input);
    if (!parsed.success)
      throw new OxyError(
        'INVALID',
        `The task is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    const current = this.require(parsed.data.id);
    if (current.task.projectId !== parsed.data.projectId)
      throw new OxyError('INVALID', 'A task cannot move to another project');
    let task: EnsembleTask;
    if (isActiveStatus(current.run.status)) task = { ...current.task, title: parsed.data.title, updatedAt: this.now() };
    else task = { ...parsed.data, createdAt: current.task.createdAt, updatedAt: this.now() };
    // A draft's run follows its pipeline and team.
    const run = current.run.status === 'draft' ? initialRun(task) : current.run;
    const record = { task, run };
    this.put(record);
    return this.forRenderer(record);
  }

  async remove(taskId: string): Promise<void> {
    const r = this.require(taskId);
    if (isActiveStatus(r.run.status)) this.dispatch(taskId, { type: 'stop' });
    await this.stopAll(taskId, true);
    for (const [id, c] of this.commands)
      if (c.taskId === taskId) await this.deps.terminals.close(id).catch(() => undefined);
    const ws = r.run.worktree;
    if (ws?.mode === 'worktree' && ws.repoRoot && !r.run.finished)
      await this.deps
        .workspace('ensemble:removeWorktree', {
          gitPath: this.gitPath(),
          repoRoot: ws.repoRoot,
          path: ws.path,
          force: true,
        })
        .catch((e: unknown) => this.deps.logger.warn(`Removing the worktree of ${taskId} failed`, e));
    this.records.delete(taskId);
    await this.store.remove(taskId);
    this.removeEmitter.fire({ taskId, projectId: r.task.projectId });
  }

  // ── commands from the user ────────────────────────────────────────────────────────────────────────────────

  /** A conductor event from the panel (start, pause, a gate decision…). */
  command(taskId: string, event: ConductorEvent): { error?: string } {
    const r = this.require(taskId);
    if (event.type === 'start' || event.type === 'resume-interrupted') {
      const problems = validateTask(r.task);
      if (problems.length) return { error: problems.map((p) => p.message).join(' ') };
      const mcp = this.deps.mcp.status();
      if (!mcp.enabled || !mcp.running)
        return {
          error: mcp.enabled
            ? `Oxytocin's MCP server is not running${mcp.error ? `: ${mcp.error}` : ''}. Agents need it to talk to Ensemble.`
            : 'Turn on Oxytocin\'s MCP server ("mcp.enabled" in Settings): agents need it to talk to Ensemble.',
        };
    }
    const result = this.dispatch(taskId, event);
    return result.error ? { error: result.error } : {};
  }

  /** An answer typed by the user (a question of an agent). */
  answer(taskId: string, questionId: string, answer: string): { error?: string } {
    const waiter = this.waiters.get(questionId);
    const result = this.dispatch(taskId, { type: 'answer', by: 'user', questionId, answer, deliver: !waiter });
    return result.error ? { error: result.error } : {};
  }

  // ── the conductor ─────────────────────────────────────────────────────────────────────────────────────────

  private dispatch(taskId: string, event: ConductorEvent): { error?: string; reply?: string; questionId?: string } {
    const r = this.records.get(taskId);
    if (!r) return { error: 'The task no longer exists.' };
    const before = r.run;
    const result = reduce(r.task, before, event, this.now());
    if (result.error && result.run.seq === before.seq && result.run.eventCount === before.eventCount) return result;
    const changed =
      event.type !== 'tick' ||
      result.effects.length > 0 ||
      result.run.eventCount !== before.eventCount ||
      result.run.seq !== before.seq ||
      result.run.status !== before.status ||
      result.run.needs.length !== before.needs.length;
    const record = { task: r.task, run: result.run };
    if (changed) this.put(record);
    else this.records.set(taskId, record);
    if (result.effects.length) {
      const effects = result.effects;
      queueMicrotask(() => {
        for (const effect of effects)
          void this.runEffect(taskId, effect).catch((e: unknown) =>
            this.deps.logger.error(`Ensemble effect ${effect.type} failed`, e),
          );
      });
    }
    return result;
  }

  private async runEffect(taskId: string, effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'prepare-workspace':
        return this.prepareWorkspace(taskId);
      case 'start-agent':
        return this.startAgent(taskId, effect.agentId, effect.resume);
      case 'deliver':
        return this.deliver(taskId, effect.agentId, effect.deliveryId, effect.text);
      case 'stop-agent':
        return this.stopAgent(taskId, effect.agentId, true);
      case 'stop-all':
        return this.stopAll(taskId, false);
      case 'run-command':
        return this.runStageCommand(taskId, effect.stageId, effect.command);
      case 'checkpoint':
        return this.checkpoint(taskId, effect.stageId, effect.message);
      case 'notify': {
        const r = this.records.get(taskId);
        if (r)
          this.deps.notify({
            title: effect.title,
            body: effect.body,
            level: effect.level,
            projectId: r.task.projectId,
            taskId,
          });
        return;
      }
      case 'question-answered': {
        const waiter = this.waiters.get(effect.questionId);
        if (waiter) {
          this.waiters.delete(effect.questionId);
          waiter(effect.answer || null);
        }
        return;
      }
    }
  }

  // ── workspace ─────────────────────────────────────────────────────────────────────────────────────────────

  private gitPath(): string {
    return this.deps.settings()['git.path'] ?? 'git';
  }

  private async prepareWorkspace(taskId: string): Promise<void> {
    const { task } = this.require(taskId);
    const project = this.deps.projects.get(task.projectId);
    if (!project) {
      this.dispatch(taskId, { type: 'workspace-failed', error: 'The project is no longer open in Oxytocin.' });
      return;
    }
    try {
      const gitPath = this.gitPath();
      const info = await this.deps.workspace('ensemble:repoInfo', { gitPath, cwd: project.rootPath });
      let worktree: WorktreeInfo;
      if (task.workspace.mode === 'current-checkout' || !info.isRepo) {
        if (task.workspace.mode === 'worktree' && !info.isRepo)
          throw new Error(`${project.rootPath} is not a git repository: choose "Current checkout" or run git init.`);
        worktree = {
          mode: 'current-checkout',
          path: project.rootPath,
          ...(info.toplevel ? { repoRoot: info.toplevel } : {}),
          ...(info.branch ? { branch: info.branch, baseRef: info.branch } : {}),
          ...(info.head ? { baseCommit: info.head } : {}),
        };
      } else {
        const repoRoot = info.toplevel!;
        const slug = slugId(task.title, [], 'task').slice(0, 24);
        const root = this.deps.settings()['ensemble.worktreeRoot'];
        const path = root
          ? join(root, projectSlug(project.name), `${slug}-${task.id.slice(-6)}`)
          : join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`, `${slug}-${task.id.slice(-6)}`);
        const branch = task.workspace.branch?.trim() || `ensemble/${slug}`;
        const added = await this.deps.workspace(
          'ensemble:addWorktree',
          { gitPath, repoRoot, path, branch, ...(task.workspace.baseRef ? { baseRef: task.workspace.baseRef } : {}) },
          { timeoutMs: 310_000 },
        );
        worktree = {
          mode: 'worktree',
          path,
          repoRoot,
          branch: added.branch,
          baseRef: added.baseRef,
          baseCommit: added.baseCommit,
        };
        // The worktree is recorded at once: a failing setup command still leaves it removable.
        const r = this.require(taskId);
        this.put({ task: r.task, run: { ...r.run, worktree } });
        if (task.workspace.copyFiles.length) {
          const relative = project.rootPath === repoRoot ? '' : project.rootPath.slice(repoRoot.length + 1);
          await this.deps.workspace('ensemble:copyFiles', {
            from: repoRoot,
            to: path,
            files: task.workspace.copyFiles.map((f) => (relative ? `${relative}/${f}` : f)),
          });
        }
        // The project may be a subfolder of the repository: agents work in the same subfolder of the worktree.
        if (project.rootPath !== repoRoot && project.rootPath.startsWith(repoRoot))
          worktree = { ...worktree, path: join(path, project.rootPath.slice(repoRoot.length + 1)) };
      }
      for (const command of task.workspace.setupCommands) {
        const result = await this.runCommand(taskId, worktree.path, command, `Setup: ${command}`);
        if (result.exitCode !== 0)
          throw new Error(
            `The setup command "${command}" failed (exit ${result.exitCode}):\n${result.output.slice(-2000)}`,
          );
      }
      const current = this.records.get(taskId);
      if (current?.run.status !== 'preparing') return;
      this.dispatch(taskId, { type: 'workspace-ready', worktree });
    } catch (e) {
      this.dispatch(taskId, { type: 'workspace-failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async checkpoint(taskId: string, stageId: string, message: string): Promise<void> {
    const ws = this.records.get(taskId)?.run.worktree;
    if (!ws || ws.mode !== 'worktree') {
      this.dispatch(taskId, { type: 'checkpoint-done', stageId });
      return;
    }
    try {
      const r = await this.deps.workspace(
        'ensemble:commitAll',
        { gitPath: this.gitPath(), cwd: ws.path, message },
        { timeoutMs: 120_000 },
      );
      this.dispatch(taskId, {
        type: 'checkpoint-done',
        stageId,
        ...(r.commit ? { commit: r.commit, files: r.files } : {}),
      });
    } catch (e) {
      this.deps.logger.warn(`Checkpoint of ${taskId} failed`, e);
      this.dispatch(taskId, { type: 'checkpoint-done', stageId });
    }
  }

  // ── commands (setup, test stages) ─────────────────────────────────────────────────────────────────────────

  /** Runs a command line in a background terminal of its own; resolves with its exit code and output. */
  private async runCommand(
    taskId: string,
    cwd: string,
    command: string,
    title: string,
    stageId?: string,
  ): Promise<{ exitCode: number; output: string; terminalId: string }> {
    const { task } = this.require(taskId);
    const info = await this.deps.terminals.create(
      { projectId: task.projectId, cwd, userTitle: title.slice(0, 80), background: true },
      { runCommand: command },
    );
    this.owned.add(info.id);
    if (stageId) this.dispatch(taskId, { type: 'command-started', stageId, terminalId: info.id });
    const done = new Promise<{ exitCode: number; output: string }>((resolve) =>
      this.commands.set(info.id, { taskId, ...(stageId ? { stageId } : {}), resolve }),
    );
    // It may have ended before the watcher was set up.
    const current = this.deps.terminals.get(info.id);
    if (current && current.state !== 'running') this.onTerminal(current);
    const r = await done;
    return { ...r, terminalId: info.id };
  }

  private async runStageCommand(taskId: string, stageId: string, command: string): Promise<void> {
    const r = this.records.get(taskId);
    const cwd = r?.run.worktree?.path;
    if (!r || !cwd) return;
    // The previous run of this stage's command goes away (its output is in the handoffs).
    for (const [id, c] of this.commands)
      if (c.taskId === taskId && c.stageId === stageId) {
        this.commands.delete(id);
        await this.deps.terminals.close(id).catch(() => undefined);
      }
    const old = r.run.stages.find((s) => s.stageId === stageId)?.terminalId;
    if (old) await this.deps.terminals.close(old).catch(() => undefined);
    try {
      const result = await this.runCommand(taskId, cwd, command, `${command}`, stageId);
      this.dispatch(taskId, { type: 'command-finished', stageId, exitCode: result.exitCode, output: result.output });
    } catch (e) {
      this.dispatch(taskId, {
        type: 'command-finished',
        stageId,
        exitCode: -1,
        output: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private onTerminal(info: TerminalInfo): void {
    const command = this.commands.get(info.id);
    if (command && info.state !== 'running') {
      this.commands.delete(info.id);
      const exitCode = info.state === 'failed' ? -1 : (info.exitCode ?? -1);
      void this.deps.pty
        .text(info.id)
        .catch(() => '')
        .then((output) => command.resolve({ exitCode, output: output.slice(-60_000) }));
      // Kept for the activity view only while the task lives (closed with the task or the next attempt).
      this.commands.set(`done:${info.id}`, { ...command, resolve: () => undefined });
      return;
    }
    if (this.live.has(info.id)) this.refreshStates();
  }

  /** Whether a terminal belongs to Ensemble (its toasts are muted; the inbox reports instead). */
  ownsTerminal(id: string): boolean {
    return this.owned.has(id);
  }

  private onTerminalRemoved(id: string): void {
    this.owned.delete(id);
    const command = this.commands.get(id);
    if (command) {
      this.commands.delete(id);
      command.resolve({ exitCode: -1, output: 'The terminal was closed.' });
    }
    if (this.live.has(id)) this.refreshStates();
  }

  // ── agents ────────────────────────────────────────────────────────────────────────────────────────────────

  private commandFor(cli: EnsembleCli): string {
    const configured = (this.deps.settings()['ensemble.commands'] as Record<string, string> | undefined)?.[cli];
    return configured?.trim() || CLI_INFO[cli].command;
  }

  private async startAgent(taskId: string, agentId: string, resume: boolean): Promise<void> {
    const r = this.require(taskId);
    const agent = r.task.agents.find((a) => a.id === agentId);
    const state = r.run.agents[agentId];
    const ws = r.run.worktree;
    if (!agent || !state || !ws) return;
    const url = this.deps.mcp.url();
    if (!url) {
      this.dispatch(taskId, {
        type: 'agent-start-failed',
        agentId,
        error: "Oxytocin's MCP server is not running (Settings → mcp.enabled).",
      });
      return;
    }
    try {
      const dir = this.store.artifactsDir(taskId);
      await mkdir(dir, { recursive: true });
      const promptFile = join(dir, `${agentId}.prompt.md`);
      await writeFile(
        promptFile,
        systemPromptText(r.task, agent, { path: ws.path, branch: ws.branch, baseRef: ws.baseRef }),
      );
      const token = randomBytes(24).toString('base64url');
      const ctx: LaunchContext = {
        command: this.commandFor(agent.cli),
        promptFile,
        configFile: join(dir, `${agentId}.mcp.json`),
        mcpUrl: url,
        token,
        sessionId: randomUUID(),
        ...(resume && state.cliSessionId && CLI_INFO[agent.cli].resume ? { resumeSessionId: state.cliSessionId } : {}),
        sessionName: sessionName(r.task.title, agent.name),
      };
      const spec = buildLaunch(agent, ctx);
      if (!spec.command) throw new Error(`No command for ${CLI_INFO[agent.cli].displayName}.`);
      for (const f of spec.files) {
        await writeFile(f.path, f.content, f.secret ? { mode: 0o600 } : {});
        if (f.secret) await chmod(f.path, 0o600).catch(() => undefined);
      }
      const custom = agent.cli === 'custom' ? customValues(agent, ctx) : undefined;
      const info = await this.deps.terminals.create(
        {
          projectId: r.task.projectId,
          cwd: ws.path,
          userTitle: `${agent.name} · ${agent.role.label}`.slice(0, 80),
          env: { ...agent.env, ...spec.env },
          background: true,
        },
        {
          initialCommandFor: (shellType) => {
            const shell: ShellKind = shellType;
            const head = custom
              ? spec.command.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) =>
                  name in custom ? quoteArg(custom[name as keyof typeof custom], shell) : m,
                )
              : spec.command;
            return commandLine(head, spec.args, shell);
          },
        },
      );
      this.owned.add(info.id);
      const live: LiveAgent = {
        taskId,
        agentId,
        terminalId: info.id,
        cli: agent.cli,
        token,
        startedAt: this.now(),
        seenAgent: false,
        lastOutputAt: 0,
        lastWorkingAt: 0,
        delivering: false,
        secretFiles: spec.files.filter((f) => f.secret).map((f) => f.path),
      };
      this.live.set(info.id, live);
      this.tokens.set(token, live);
      this.dispatch(taskId, {
        type: 'agent-started',
        agentId,
        terminalId: info.id,
        ...(spec.cliSessionId ? { cliSessionId: spec.cliSessionId } : {}),
      });
    } catch (e) {
      this.dispatch(taskId, { type: 'agent-start-failed', agentId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private liveOf(taskId: string, agentId: string): LiveAgent | undefined {
    const terminalId = this.records.get(taskId)?.run.agents[agentId]?.terminalId;
    const a = terminalId ? this.live.get(terminalId) : undefined;
    return a && a.taskId === taskId ? a : undefined;
  }

  private revoke(a: LiveAgent): void {
    this.tokens.delete(a.token);
    this.deps.mcp.endSessions(a.token);
    for (const f of a.secretFiles) void rm(f, { force: true }).catch(() => undefined);
  }

  /** Stops an agent's CLI; `close` also removes its terminal (a restart or a fresh session). */
  private async stopAgent(taskId: string, agentId: string, close: boolean): Promise<void> {
    for (const [id, a] of [...this.live]) {
      if (a.taskId !== taskId || a.agentId !== agentId) continue;
      this.live.delete(id);
      this.revoke(a);
      await (close ? this.deps.terminals.close(id) : this.deps.terminals.kill(id)).catch(() => undefined);
    }
  }

  /** Every agent and command of the task stops; terminals stay for reading unless `close`. */
  private async stopAll(taskId: string, close: boolean): Promise<void> {
    for (const [id, a] of [...this.live]) {
      if (a.taskId !== taskId) continue;
      this.live.delete(id);
      this.revoke(a);
      await (close ? this.deps.terminals.close(id) : this.deps.terminals.kill(id)).catch(() => undefined);
    }
    for (const [id, c] of [...this.commands]) {
      if (c.taskId !== taskId || id.startsWith('done:')) continue;
      await this.deps.terminals.kill(id, true).catch(() => undefined);
    }
    if (close) {
      for (const [id, c] of [...this.commands]) {
        if (c.taskId !== taskId) continue;
        this.commands.delete(id);
        await this.deps.terminals.close(id.replace(/^done:/, '')).catch(() => undefined);
      }
      const r = this.records.get(taskId);
      for (const s of Object.values(r?.run.agents ?? {}))
        if (s.terminalId && !this.live.has(s.terminalId))
          await this.deps.terminals.close(s.terminalId).catch(() => undefined);
    }
    for (const [id, waiter] of [...this.waiters]) {
      const q = this.records.get(taskId)?.run.questions.find((x) => x.id === id);
      if (q) {
        this.waiters.delete(id);
        waiter(null);
      }
    }
  }

  /** The state an agent is in, from Oxytocin's agent detection plus heuristics for CLIs without exact states. */
  private effectiveState(a: LiveAgent): AgentLive {
    const term = this.deps.terminals.get(a.terminalId);
    if (!term || term.state !== 'running') return 'exited';
    const now = this.now();
    const info = this.agentsByTerminal.get(a.terminalId);
    const heuristic = CLI_INFO[a.cli].states === 'heuristic';
    if (info) {
      a.seenAgent = true;
      a.firstSeenAt ??= now;
      if (info.state === 'working' || info.state === 'idle' || info.state === 'waiting') return info.state;
      // CLIs without exact states: ready once their start-up output went quiet. Claude Code always reports
      // its state, so it is never guessed (a trust prompt is quiet, too).
      if (heuristic && now - a.lastOutputAt >= 3000 && now - a.firstSeenAt >= 2000) return 'idle';
      return 'starting';
    }
    if (a.seenAgent) return 'exited';
    if (a.cli === 'custom') {
      if (a.lastOutputAt === 0 || now - a.startedAt < 3000) return 'starting';
      return now - a.lastOutputAt < 1500 ? 'working' : 'idle';
    }
    return 'starting';
  }

  private refreshStates(): void {
    for (const a of [...this.live.values()]) {
      const state = this.effectiveState(a);
      if (state === 'working') a.lastWorkingAt = this.now();
      if (state === a.reported) continue;
      a.reported = state;
      this.dispatch(a.taskId, { type: 'agent-state', agentId: a.agentId, state });
      if (state === 'exited') {
        this.live.delete(a.terminalId);
        this.revoke(a);
      }
    }
  }

  private async deliver(taskId: string, agentId: string, deliveryId: string, text: string): Promise<void> {
    const a = this.liveOf(taskId, agentId);
    if (!a) {
      this.dispatch(taskId, { type: 'delivery-failed', agentId, deliveryId, error: 'The agent is not running.' });
      return;
    }
    if (a.delivering) return;
    a.delivering = true;
    try {
      // A question on screen (trust, login, y/n) must never receive the message.
      const screen = await this.deps.pty.text(a.terminalId).catch(() => '');
      const tail = screen.split('\n').slice(-25).join('\n');
      if (BLOCKING_PROMPT.test(tail)) {
        this.dispatch(taskId, {
          type: 'delivery-failed',
          agentId,
          deliveryId,
          error: 'a question is open in its terminal (trust, login, yes/no): answer it there, then retry',
        });
        return;
      }
      const result = await deliver(text, {
        precise: CLI_INFO[a.cli].states === 'registry',
        state: () => (this.live.has(a.terminalId) ? this.effectiveState(a) : 'exited'),
        lastOutputAt: () => a.lastOutputAt,
        lastWorkingAt: () => a.lastWorkingAt,
        paste: async (t) => {
          await this.deps.pty.paste(a.terminalId, t, true);
        },
        enter: async () => {
          await this.deps.pty.write(a.terminalId, '\r');
        },
      });
      if (result.ok) this.dispatch(taskId, { type: 'delivered', agentId, deliveryId });
      else this.dispatch(taskId, { type: 'delivery-failed', agentId, deliveryId, error: result.error });
    } finally {
      a.delivering = false;
    }
  }

  // ── timers ────────────────────────────────────────────────────────────────────────────────────────────────

  tick(): void {
    this.refreshStates();
    for (const r of this.records.values()) if (r.run.status === 'running') this.dispatch(r.task.id, { type: 'tick' });
  }

  // ── MCP (oxy_ensemble_*) ─────────────────────────────────────────────────────────────────────────────────

  describe(token: string): { label: string; projectId: string; terminalId: string } | null {
    const a = this.tokens.get(token);
    if (!a) return null;
    const r = this.records.get(a.taskId);
    const agent = r?.task.agents.find((x) => x.id === a.agentId);
    if (!r || !agent) return null;
    return { label: `${agent.name} · ${r.task.title}`, projectId: r.task.projectId, terminalId: a.terminalId };
  }

  tools() {
    return ENSEMBLE_TOOLS;
  }

  instructions(): string {
    return 'Oxytocin Ensemble: you are one agent of a team working on a task. Call oxy_ensemble_context for your assignment and oxy_ensemble_submit when you are done.';
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    o: { token: string; signal: AbortSignal },
  ): Promise<McpToolResult> {
    const a = this.tokens.get(o.token);
    if (!a)
      return { content: [{ type: 'text', text: 'This terminal is not part of an Ensemble task.' }], isError: true };
    return runEnsembleTool(
      {
        context: (taskId, agentId) => {
          const r = this.require(taskId);
          const agent = r.task.agents.find((x) => x.id === agentId);
          const c = agentContext(r.task, r.run, agentId, { includeRole: agent ? !readsPromptFile(agent.cli) : true });
          this.dispatch(taskId, { type: 'context-served', agentId, items: c.items });
          return c;
        },
        submit: (taskId, agentId, submission) => {
          const result = this.dispatch(taskId, { type: 'submit', agentId, submission: submission as Submission });
          return { ...(result.reply ? { reply: result.reply } : {}), ...(result.error ? { error: result.error } : {}) };
        },
        progress: (taskId, agentId, message, percent) => {
          const key = `${taskId}/${agentId}`;
          const last = this.lastProgress.get(key) ?? 0;
          if (this.now() - last < PROGRESS_INTERVAL_MS) return;
          this.lastProgress.set(key, this.now());
          this.dispatch(taskId, { type: 'progress', agentId, message, percent });
        },
        ask: async (taskId, agentId, to, question, waitMs, signal) => {
          const result = this.dispatch(taskId, { type: 'ask', from: agentId, to, question });
          if (result.error || !result.questionId) return { error: result.error ?? 'The question could not be asked.' };
          const questionId = result.questionId;
          if (waitMs <= 0) return { questionId };
          const answer = await new Promise<string | null>((resolve) => {
            const timer = setTimeout(() => {
              this.waiters.delete(questionId);
              resolve(null);
            }, waitMs);
            const finish = (value: string | null) => {
              clearTimeout(timer);
              resolve(value);
            };
            this.waiters.set(questionId, finish);
            signal.addEventListener(
              'abort',
              () => {
                this.waiters.delete(questionId);
                finish(null);
              },
              { once: true },
            );
          });
          return answer === null ? { questionId } : { questionId, answer };
        },
        answer: (taskId, agentId, questionId, text) => {
          const waiter = this.waiters.get(questionId);
          const result = this.dispatch(taskId, {
            type: 'answer',
            by: agentId,
            questionId,
            answer: text,
            deliver: !waiter,
          });
          return { ...(result.reply ? { reply: result.reply } : {}), ...(result.error ? { error: result.error } : {}) };
        },
        note: (taskId, agentId, text) => {
          const result = this.dispatch(taskId, { type: 'note', by: agentId, text });
          return { ...(result.reply ? { reply: result.reply } : {}), ...(result.error ? { error: result.error } : {}) };
        },
      },
      name,
      args,
      { taskId: a.taskId, agentId: a.agentId },
      o.signal,
    );
  }

  // ── builder checks, changes, finishing ────────────────────────────────────────────────────────────────────

  private readonly cliCache = new Map<string, { at: number; status: Promise<CliStatus> }>();

  private cliStatus(cli: EnsembleCli): Promise<CliStatus> {
    const command = this.commandFor(cli);
    const key = `${cli}\0${command}`;
    const cached = this.cliCache.get(key);
    if (cached && this.now() - cached.at < 5 * 60_000) return cached.status;
    const status = (async (): Promise<CliStatus> => {
      if (!command)
        return { cli, installed: false, command, problem: 'Set a command for the custom CLI on the agent card.' };
      const found = await this.deps.detect(command).catch(() => ({ installed: false, problem: 'Detection failed' }));
      return { cli, command, ...found };
    })();
    this.cliCache.set(key, { at: this.now(), status });
    return status;
  }

  async checks(projectId: string, clis: EnsembleCli[]): Promise<EnsembleChecks> {
    const project = this.deps.projects.get(projectId);
    const unique = [...new Set(clis.filter((c) => c !== 'custom'))];
    const [statuses, repo] = await Promise.all([
      Promise.all(unique.map((c) => this.cliStatus(c))),
      project
        ? this.deps
            .workspace('ensemble:repoInfo', { gitPath: this.gitPath(), cwd: project.rootPath })
            .catch((e: unknown) => ({
              isRepo: false,
              toplevel: null,
              branch: null,
              head: null,
              dirty: 0,
              localFiles: [] as string[],
              error: e instanceof Error ? e.message : String(e),
            }))
        : Promise.resolve(null),
    ]);
    return {
      clis: statuses,
      mcp: this.deps.mcp.status(),
      bridge: this.deps.bridgeEnabled(),
      repo: repo
        ? {
            isRepo: repo.isRepo,
            branch: repo.branch,
            head: repo.head,
            dirty: repo.dirty,
            ...(repo.error ? { error: repo.error } : {}),
          }
        : { isRepo: false, branch: null, head: null, dirty: 0, error: 'Project not found' },
      untracked: repo?.localFiles ?? [],
    };
  }

  async changes(taskId: string, from?: string, to?: string): Promise<EnsembleChange[]> {
    const ws = this.require(taskId).run.worktree;
    if (!ws?.baseCommit) return [];
    const params = { gitPath: this.gitPath(), cwd: ws.path, base: from ?? ws.baseCommit, ...(to ? { head: to } : {}) };
    return this.deps.workspace('ensemble:changes', params, { timeoutMs: 60_000 });
  }

  async fileDiff(
    taskId: string,
    path: string,
    o: { oldPath?: string | undefined; from?: string | undefined; to?: string | undefined },
  ): Promise<{ original: string | null; modified: string | null }> {
    const ws = this.require(taskId).run.worktree;
    if (!ws?.baseCommit) return { original: null, modified: null };
    const gitPath = this.gitPath();
    const maxBytes = Math.round((this.deps.settings()['git.diff.maxFileSizeMb'] ?? 2) * 1024 * 1024);
    const original = await this.deps.workspace('ensemble:fileAt', {
      gitPath,
      cwd: ws.path,
      ref: o.from ?? ws.baseCommit,
      path: o.oldPath ?? path,
      maxBytes,
    });
    let modified: string | null;
    if (o.to)
      modified = await this.deps.workspace('ensemble:fileAt', { gitPath, cwd: ws.path, ref: o.to, path, maxBytes });
    else {
      const file = join(ws.path, ...path.split('/'));
      const info = await stat(file).catch(() => null);
      modified = info?.isFile() && info.size <= maxBytes ? await readFile(file, 'utf8').catch(() => null) : null;
    }
    return { original, modified };
  }

  async finish(taskId: string, action: FinishAction): Promise<{ detail: string }> {
    const r = this.require(taskId);
    if (isActiveStatus(r.run.status)) throw new OxyError('INVALID', 'Stop the task first.');
    const ws = r.run.worktree;
    if (!ws || ws.mode !== 'worktree' || !ws.repoRoot || !ws.branch || !ws.baseRef)
      throw new OxyError('INVALID', 'This task worked in your checkout: there is no branch to finish.');
    await this.stopAll(taskId, false);
    const result = await this.deps.workspace(
      'ensemble:finish',
      {
        gitPath: this.gitPath(),
        action,
        repoRoot: ws.repoRoot,
        worktreePath: ws.path,
        branch: ws.branch,
        baseRef: ws.baseRef,
        message: `${r.task.title}\n\nBuilt by an Oxytocin Ensemble.`,
        removeWorktree: true,
      },
      { timeoutMs: 320_000 },
    );
    this.dispatch(taskId, { type: 'finished', action, detail: result.detail });
    return result;
  }

  report(taskId: string): string {
    const r = this.require(taskId);
    return runReport(r.task, r.run, this.now());
  }

  /** The prompt preview of the builder (layers 1–3). */
  promptPreview(task: EnsembleTask, agent: EnsembleAgent): string {
    return systemPromptText(task, agent, {});
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Before quitting: the runs are saved (running ones become interrupted at the next start). */
  async flush(): Promise<void> {
    for (const a of this.live.values()) this.revoke(a);
    await this.store.flush();
  }

  /** Test hook: the run of a task. */
  runOf(taskId: string): EnsembleRun | undefined {
    return this.records.get(taskId)?.run;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.publishTimers.values()) clearTimeout(t);
    this.disposables.dispose();
    this.changeEmitter.dispose();
    this.removeEmitter.dispose();
  }
}
