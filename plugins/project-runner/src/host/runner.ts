import type { Disposable, TerminalMeta, TerminalsApi } from '@oxytocin/plugin-api';
import { detectPrompt, findListeningPort, findLocalUrls, LogBuffer, stripAnsi, TERMINATE_BATCH_PROMPT } from './output';
import type { RunProfile, RunPrompt, RunSnapshot, RunStatus, StartedBy } from '../shared/types';

export type { RunPrompt, RunSnapshot, RunStatus, StartedBy };

/** A run's terminal as the plugin remembers it. */
export interface TerminalLink {
  terminalId: string;
  projectId: string;
  profileId: string;
  setup?: string;
}

interface Run {
  projectId: string;
  profileId: string;
  profile: RunProfile;
  status: RunStatus;
  terminalId?: string;
  /** Folder and environment the terminal was created with (a different profile setup needs a new terminal). */
  terminalSetup?: string;
  startedAt?: number;
  startedBy?: StartedBy;
  exitCode?: number;
  url?: string;
  ports: number[];
  log: LogBuffer;
  output?: Disposable;
  /** Delays unsubscribing after the command ended (its last lines arrive with or after the end mark). */
  outputLinger?: ReturnType<typeof setTimeout>;
  /** The command was seen running (shell integration) or a process ran in the terminal (fallback). */
  sawStart: boolean;
  stopRequested: boolean;
  timers: ReturnType<typeof setTimeout>[];
  portPoll?: ReturnType<typeof setTimeout>;
  /** A question the app waits on (it would otherwise look like it hangs while starting). */
  prompt?: RunPrompt;
  /** Checks for a question once the output has been quiet for a moment. */
  promptCheck?: ReturnType<typeof setTimeout>;
  /**
   * The last question that went away without an answer (new output, e.g. the app redrawing it). Found again, it
   * keeps its id, so a notification about it still answers it.
   */
  unansweredPrompt?: RunPrompt;
}

export interface RunnerDeps {
  terminals: Pick<
    TerminalsApi,
    'list' | 'create' | 'sendText' | 'show' | 'kill' | 'close' | 'getListeningPorts' | 'onDidWriteData'
  >;
  now?: () => number;
  /** Delays of the stop escalation: a second Ctrl+C, then a forced kill (ms). */
  stopDelays?: { interrupt: number; kill: number };
  /** Without a URL, a command that keeps running this long counts as running (ms). */
  settleMs?: number;
  /** How long the output must be quiet before its unfinished last line counts as a question (ms). */
  promptQuietMs?: number;
  log?: (message: string, error?: unknown) => void;
}

const isActive = (s: RunStatus) => s === 'starting' || s === 'running' || s === 'stopping';
/** Exit codes of an interrupt (Ctrl+C in bash/zsh, SIGTERM, STATUS_CONTROL_C_EXIT on Windows): a stop, not a failure. */
const INTERRUPTED = new Set([130, 143, -1073741510, 3221225786]);

const keyOf = (projectId: string, profileId: string) => `${projectId}\u0000${profileId}`;
const PORT_POLL_FAST_MS = 2000;
const PROMPT_QUIET_MS = 600;
const PORT_POLL_SLOW_MS = 10_000;
const FAST_POLL_WINDOW_MS = 60_000;

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/** Whether two absolute folders are the same (separators, trailing slashes and case on Windows/macOS ignored). */
export function samePath(a: string, b: string, insensitive = caseInsensitive): boolean {
  const norm = (p: string) => {
    const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return insensitive ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/** Absolute folder of a profile. */
export function profileFolder(rootPath: string, cwd: string): string {
  if (!cwd) return rootPath;
  const sep = rootPath.includes('\\') ? '\\' : '/';
  return `${rootPath.replace(/[\\/]+$/, '')}${sep}${cwd.split('/').join(sep)}`;
}

/**
 * Runs profiles in terminals: one terminal per profile (started in the background, shown on demand), reused while
 * its shell is idle. Tracks the status from shell integration (command start/end, exit code) or the terminal's
 * foreground process, the URL from the output and the listening ports of the process tree.
 */
export class RunManager implements Disposable {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(projectId: string) => void>();
  private readonly now: () => number;
  private nextPromptId = 1;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  onDidChange(listener: (projectId: string) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(run: Run): void {
    for (const l of [...this.listeners]) l(run.projectId);
  }

  private run(projectId: string, profile: RunProfile): Run {
    const key = keyOf(projectId, profile.id);
    let run = this.runs.get(key);
    if (!run) {
      run = {
        projectId,
        profileId: profile.id,
        profile,
        status: 'idle',
        ports: [],
        log: new LogBuffer(),
        sawStart: false,
        stopRequested: false,
        timers: [],
      };
      this.runs.set(key, run);
    }
    run.profile = profile;
    return run;
  }

  private find(projectId: string, profileId: string): Run | undefined {
    return this.runs.get(keyOf(projectId, profileId));
  }

  snapshot(projectId: string, profileId: string): RunSnapshot {
    const run = this.find(projectId, profileId);
    if (!run) return { profileId, status: 'idle', ports: [] };
    return {
      profileId,
      name: run.profile.name,
      status: run.status,
      ports: run.ports,
      ...(run.url ? { url: run.url } : {}),
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.startedBy ? { startedBy: run.startedBy } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      ...(run.terminalId ? { terminalId: run.terminalId } : {}),
      ...(run.prompt ? { prompt: run.prompt } : {}),
    };
  }

  /** Runs whose app is starting, running or stopping. */
  active(): (RunSnapshot & { projectId: string })[] {
    return [...this.runs.values()]
      .filter((r) => isActive(r.status))
      .map((r) => ({ ...this.snapshot(r.projectId, r.profileId), projectId: r.projectId }));
  }

  activeIn(projectId: string): RunSnapshot[] {
    return [...this.runs.values()]
      .filter((r) => r.projectId === projectId && isActive(r.status))
      .map((r) => this.snapshot(r.projectId, r.profileId));
  }

  logs(projectId: string, profileId: string, lines: number): string[] {
    return this.find(projectId, profileId)?.log.tail(lines) ?? [];
  }

  private async terminal(run: Run): Promise<TerminalMeta | undefined> {
    if (!run.terminalId) return undefined;
    const list = await this.deps.terminals.list({ projectId: run.projectId });
    return list.find((t) => t.id === run.terminalId);
  }

  private clearTimers(run: Run): void {
    for (const t of run.timers) clearTimeout(t);
    run.timers = [];
    if (run.portPoll) clearTimeout(run.portPoll);
    run.portPoll = undefined;
    if (run.promptCheck) clearTimeout(run.promptCheck);
    run.promptCheck = undefined;
    delete run.prompt;
    delete run.unansweredPrompt;
  }

  /** Starts a profile (no-op while it is already starting or running). */
  async start(rootPath: string, projectId: string, profile: RunProfile, startedBy: StartedBy): Promise<RunSnapshot> {
    const run = this.run(projectId, profile);
    if (run.status === 'starting' || run.status === 'running') return this.snapshot(projectId, profile.id);
    if (run.status === 'stopping') throw new Error(`${profile.name} is still stopping.`);
    // Claimed before the first await: a second start (double click, the UI and an agent) is a no-op.
    this.clearTimers(run);
    this.stopOutput(run);
    run.log.clear();
    run.status = 'starting';
    run.startedAt = this.now();
    run.startedBy = startedBy;
    run.stopRequested = false;
    run.sawStart = false;
    run.ports = [];
    delete run.url;
    delete run.exitCode;
    this.changed(run);
    const cwd = profileFolder(rootPath, profile.cwd);
    const setup = JSON.stringify([cwd, profile.env ?? {}]);
    try {
      const existing = await this.terminal(run);
      // Reused only while its shell is idle in the profile's folder (the user may have `cd`-ed elsewhere). A profile
      // that runs in a new terminal never reuses one.
      const idle =
        !profile.newTerminal &&
        existing &&
        existing.status === 'running' &&
        !existing.command &&
        existing.kind !== 'process' &&
        run.terminalSetup === setup &&
        (!existing.cwd || samePath(existing.cwd, cwd));
      if (run.stopRequested) return this.cancelStart(run);
      if (idle && existing) {
        this.watchOutput(run, existing.id);
        await this.deps.terminals.sendText(existing.id, profile.command);
      } else {
        // A finished background terminal is replaced; one the user opened (or a new terminal tab of an earlier run)
        // stays where it is.
        if (existing?.background) await this.deps.terminals.close(existing.id).catch(() => undefined);
        const meta = await this.deps.terminals.create({
          projectId,
          cwd,
          title: profile.name,
          command: profile.command,
          ...(profile.env ? { env: profile.env } : {}),
          reveal: !!profile.newTerminal,
        });
        run.terminalId = meta.id;
        run.terminalSetup = setup;
        // Stopped while the terminal was being created: it never gets the command running for long.
        if (run.stopRequested) {
          await this.deps.terminals.close(meta.id).catch(() => undefined);
          return this.cancelStart(run);
        }
        this.watchOutput(run, meta.id);
      }
    } catch (e) {
      run.status = 'failed';
      run.log.push(`Could not start: ${e instanceof Error ? e.message : String(e)}\n`);
      this.changed(run);
      throw e;
    }
    // Apps without a URL (workers, console apps): running once the command kept going for a moment.
    run.timers.push(
      setTimeout(() => {
        if (run.status === 'starting' && run.sawStart) this.setStatus(run, 'running');
      }, this.deps.settleMs ?? 4000),
    );
    this.schedulePortPoll(run, 1000);
    return this.snapshot(projectId, profile.id);
  }

  private cancelStart(run: Run): RunSnapshot {
    this.finish(run, undefined);
    return this.snapshot(run.projectId, run.profileId);
  }

  private stopOutput(run: Run): void {
    if (run.outputLinger) clearTimeout(run.outputLinger);
    run.outputLinger = undefined;
    run.output?.dispose();
    run.output = undefined;
  }

  private watchOutput(run: Run, terminalId: string): void {
    run.output = this.deps.terminals.onDidWriteData(terminalId, (data) => this.onOutput(run, data));
  }

  private onOutput(run: Run, data: string): void {
    const lines = run.log.push(data);
    if (run.stopRequested && TERMINATE_BATCH_PROMPT.test(stripAnsi(data)) && run.terminalId)
      void this.deps.terminals.sendText(run.terminalId, 'Y').catch(() => undefined);
    if (run.status !== 'starting' && run.status !== 'running') return;
    let changed = false;
    // New output: the question (if any) was answered or replaced; look again once the output is quiet.
    if (run.prompt && stripAnsi(data).trim()) {
      run.unansweredPrompt = run.prompt;
      delete run.prompt;
      changed = true;
    }
    if (run.promptCheck) clearTimeout(run.promptCheck);
    run.promptCheck = setTimeout(() => this.checkPrompt(run), this.deps.promptQuietMs ?? PROMPT_QUIET_MS);
    for (const line of lines) {
      if (!run.url) {
        const url = findLocalUrls(line)[0];
        const port = url ? undefined : findListeningPort(line);
        if (url) run.url = url;
        else if (port) run.url = `http://localhost:${port}`;
        if (run.url) changed = true;
      }
    }
    if (run.url && run.status === 'starting') {
      run.sawStart = true;
      this.setStatus(run, 'running');
    } else if (changed) this.changed(run);
  }

  private checkPrompt(run: Run): void {
    run.promptCheck = undefined;
    if ((run.status !== 'starting' && run.status !== 'running') || run.stopRequested || run.prompt) return;
    const found = detectPrompt(run.log.pending(), run.log.tail(4).slice(0, -1));
    if (!found) return;
    const again = run.unansweredPrompt;
    delete run.unansweredPrompt;
    run.prompt = { id: again && again.text === found.text ? again.id : this.nextPromptId++, ...found };
    this.changed(run);
  }

  /**
   * Answers the question a run waits on (typed into its terminal with Enter). With `promptId`, only while that
   * question is still the open one (a stale notification button does nothing).
   */
  async answer(projectId: string, profileId: string, text: string, promptId?: number): Promise<RunSnapshot> {
    const run = this.find(projectId, profileId);
    if (!run?.terminalId || (run.status !== 'starting' && run.status !== 'running'))
      throw new Error('The app is not running.');
    if (promptId !== undefined && run.prompt?.id !== promptId) return this.snapshot(projectId, profileId);
    delete run.prompt;
    delete run.unansweredPrompt;
    this.changed(run);
    await this.deps.terminals.sendText(run.terminalId, text);
    return this.snapshot(projectId, profileId);
  }

  private setStatus(run: Run, status: RunStatus): void {
    if (run.status === status) return;
    run.status = status;
    this.changed(run);
  }

  private schedulePortPoll(run: Run, delay: number): void {
    if (run.portPoll) clearTimeout(run.portPoll);
    run.portPoll = setTimeout(() => void this.pollPorts(run), delay);
  }

  private async pollPorts(run: Run): Promise<void> {
    run.portPoll = undefined;
    if (!run.terminalId || (run.status !== 'starting' && run.status !== 'running')) return;
    try {
      const ports = await this.deps.terminals.getListeningPorts(run.terminalId);
      if (JSON.stringify(ports) !== JSON.stringify(run.ports)) {
        run.ports = ports;
        if (!run.url && ports.length > 0) {
          const expected = Number(/:(\d+)/.exec(run.profile.url ?? '')?.[1]);
          const port = ports.includes(expected) ? expected : ports[0]!;
          run.url = `${run.profile.url?.startsWith('https:') && port === expected ? 'https' : 'http'}://localhost:${port}`;
        }
        if (ports.length > 0 && run.status === 'starting') {
          run.sawStart = true;
          run.status = 'running';
        }
        this.changed(run);
      }
    } catch (e) {
      this.deps.log?.(`Listening ports of ${run.terminalId} failed`, e);
    }
    if (run.status !== 'starting' && run.status !== 'running') return;
    const fast = this.now() - (run.startedAt ?? 0) < FAST_POLL_WINDOW_MS;
    this.schedulePortPoll(run, fast ? PORT_POLL_FAST_MS : PORT_POLL_SLOW_MS);
  }

  /** Terminal metadata changed (`onDidChange`): command start/end, exit, foreground process. */
  onTerminalChange(meta: TerminalMeta): void {
    const run = [...this.runs.values()].find((r) => r.terminalId === meta.id);
    if (!run || run.status === 'idle' || !run.startedAt) return;
    const active = run.status === 'starting' || run.status === 'running' || run.status === 'stopping';
    if (!active) return;
    if (meta.status === 'exited') {
      this.finish(run, meta.exitCode);
      return;
    }
    if (meta.shellIntegration) {
      if (meta.command && meta.command.startedAt >= run.startedAt - 1000) run.sawStart = true;
      const last = meta.lastCommand;
      if (run.sawStart && !meta.command && last && last.finishedAt >= run.startedAt) this.finish(run, last.exitCode);
    } else if (meta.kind === 'process') run.sawStart = true;
    else if (run.sawStart && meta.kind === 'shell') this.finish(run, undefined);
  }

  /** The terminal was closed (by the user or a stop that had to kill it). */
  onTerminalClose(id: string): void {
    const run = [...this.runs.values()].find((r) => r.terminalId === id);
    if (!run) return;
    delete run.terminalId;
    delete run.terminalSetup;
    this.stopOutput(run);
    if (run.status === 'starting' || run.status === 'running' || run.status === 'stopping') this.finish(run, undefined);
  }

  private finish(run: Run, exitCode: number | undefined): void {
    this.clearTimers(run);
    if (run.output && !run.outputLinger) run.outputLinger = setTimeout(() => this.stopOutput(run), 1500);
    const requested = run.stopRequested;
    run.stopRequested = false;
    run.ports = [];
    if (exitCode !== undefined) run.exitCode = exitCode;
    run.status =
      requested || exitCode === undefined || exitCode === 0 || INTERRUPTED.has(exitCode) ? 'stopped' : 'failed';
    this.changed(run);
  }

  /** Ctrl+C, a second Ctrl+C, then a forced kill of the terminal's process tree. */
  async stop(projectId: string, profileId: string): Promise<RunSnapshot> {
    const run = this.find(projectId, profileId);
    if (!run || (run.status !== 'starting' && run.status !== 'running')) return this.snapshot(projectId, profileId);
    delete run.prompt;
    delete run.unansweredPrompt;
    if (!run.terminalId || (run.status === 'starting' && !run.output)) {
      // Still being set up: start() sees the request and cancels.
      run.stopRequested = true;
      this.setStatus(run, 'stopping');
      return this.snapshot(projectId, profileId);
    }
    const terminalId = run.terminalId;
    run.stopRequested = true;
    this.setStatus(run, 'stopping');
    const stillStopping = () => run.status === 'stopping' && run.terminalId === terminalId;
    const delays = this.deps.stopDelays ?? { interrupt: 3000, kill: 8000 };
    await this.deps.terminals.sendText(terminalId, '\x03', { addNewLine: false }).catch(() => undefined);
    run.timers.push(
      setTimeout(() => {
        if (stillStopping())
          void this.deps.terminals.sendText(terminalId, '\x03', { addNewLine: false }).catch(() => undefined);
      }, delays.interrupt),
      setTimeout(() => {
        if (!stillStopping()) return;
        void this.deps.terminals
          .kill(terminalId, { force: true })
          .catch(() => undefined)
          .then(() => {
            if (stillStopping()) this.finish(run, undefined);
          });
      }, delays.kill),
    );
    return this.snapshot(projectId, profileId);
  }

  /** Resolves when the profile left `stopping` (at most `timeoutMs`). */
  waitForStop(projectId: string, profileId: string, timeoutMs = 12_000): Promise<RunSnapshot> {
    return this.waitFor(projectId, profileId, (s) => s.status !== 'stopping', timeoutMs);
  }

  /** Resolves with the first snapshot matching `done` (or the current one after `timeoutMs`). */
  waitFor(
    projectId: string,
    profileId: string,
    done: (s: RunSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<RunSnapshot> {
    const current = this.snapshot(projectId, profileId);
    if (done(current)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        sub.dispose();
        resolve(this.snapshot(projectId, profileId));
      };
      const timer = setTimeout(finish, timeoutMs);
      const sub = this.onDidChange((id) => {
        if (id === projectId && done(this.snapshot(projectId, profileId))) finish();
      });
    });
  }

  async restart(rootPath: string, projectId: string, profile: RunProfile, startedBy: StartedBy): Promise<RunSnapshot> {
    const current = this.snapshot(projectId, profile.id);
    if (current.status === 'starting' || current.status === 'running') {
      await this.stop(projectId, profile.id);
      await this.waitForStop(projectId, profile.id);
    } else if (current.status === 'stopping') await this.waitForStop(projectId, profile.id);
    return this.start(rootPath, projectId, profile, startedBy);
  }

  /** Terminals of the runs, for adopting them again after the plugin restarted (host crash, reload, re-enable). */
  terminalLinks(): TerminalLink[] {
    return [...this.runs.values()]
      .filter((r) => r.terminalId)
      .map((r) => ({
        terminalId: r.terminalId!,
        projectId: r.projectId,
        profileId: r.profileId,
        ...(r.terminalSetup ? { setup: r.terminalSetup } : {}),
      }));
  }

  /**
   * Takes a profile's terminal over from a previous instance of the plugin: its output is followed again and the
   * run shows as running when a command or a process still runs in it.
   */
  adopt(projectId: string, profile: RunProfile, meta: TerminalMeta, setup?: string): void {
    const run = this.run(projectId, profile);
    if (run.terminalId || meta.status !== 'running') return;
    run.terminalId = meta.id;
    if (setup) run.terminalSetup = setup;
    const busy = !!meta.command || meta.kind === 'process';
    run.status = busy ? 'running' : 'stopped';
    run.sawStart = busy;
    run.startedAt = meta.command?.startedAt ?? this.now();
    this.watchOutput(run, meta.id);
    if (busy) this.schedulePortPoll(run, 0);
    this.changed(run);
  }

  /** Shows the profile's terminal (its logs); false when it never ran. */
  async showLogs(projectId: string, profileId: string, preserveFocus = false): Promise<boolean> {
    const run = this.find(projectId, profileId);
    if (!run?.terminalId) return false;
    await this.deps.terminals.show(run.terminalId, { preserveFocus });
    return true;
  }

  /** Forgets runs of profiles that no longer exist (their terminals keep running until stopped by the user). */
  forgetMissing(projectId: string, profileIds: Set<string>): void {
    for (const [key, run] of [...this.runs]) {
      if (run.projectId !== projectId || profileIds.has(run.profileId)) continue;
      if (run.status === 'starting' || run.status === 'running' || run.status === 'stopping') continue;
      this.clearTimers(run);
      this.stopOutput(run);
      this.runs.delete(key);
    }
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      this.clearTimers(run);
      this.stopOutput(run);
    }
    this.runs.clear();
    this.listeners.clear();
  }
}
