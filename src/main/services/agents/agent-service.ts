import type {
  AgentInfo,
  AgentInfoWithTerminal,
  AgentState,
  AgentStateReport,
  AgentStateSource,
} from '@shared/domain/agent';
import type { ProcInfo, TerminalInfo } from '@shared/domain/terminal';
import type { Logger } from '@shared/logging/logger';
import type { PtyHostEvents, PtyHostMethods } from '@shared/rpc/contracts/pty-host';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { UtilityHost } from '../../hosts/utility-host';
import type { TerminalRuntimePatch } from '../terminals/terminal-service';
import { type AgentRule, classifyTerminal, DEFAULT_AGENT_RULES } from './rules';
import { type ClaudeRegistry, mapRegistryStatus, type RegistryEntry } from './claude-registry';

/** higher wins; a lower source may not override a higher one for 10 s. */
const PRIORITY: Record<AgentStateSource, number> = {
  hook: 5,
  'claude-registry': 4,
  'osc-progress': 3,
  bell: 2,
  'output-heuristic': 1,
  none: 0,
};
const OVERRIDE_WINDOW_MS = 10_000;
const STARTING_MAX_MS = 10_000;
const OUTPUT_WORKING_MS = 2_000;
const OUTPUT_IDLE_MS = 8_000;
/** A plain process must live this long before a shell is shown as PROCESS. */
const PROCESS_CONFIRM_MS = 1_000;
const SHELL_NAMES = new Set([
  'bash',
  'zsh',
  'fish',
  'sh',
  'dash',
  'pwsh',
  'powershell',
  'cmd',
  'bash.exe',
  'pwsh.exe',
  'powershell.exe',
  'cmd.exe',
]);

/** Built-in agent profiles (`agent:<name>`) → detection rule ids. */
const PROFILE_RULES: Record<string, string> = {
  'agent:claude': 'claude-code',
  'agent:codex': 'codex',
  'agent:gemini': 'gemini-cli',
  'agent:aider': 'aider',
  'agent:opencode': 'opencode',
};

export interface AgentTerminalsPort {
  get(id: string): TerminalInfo | undefined;
  list(): TerminalInfo[];
  applyRuntime(id: string, patch: TerminalRuntimePatch): void;
  onDidUpdate: (listener: (info: TerminalInfo) => void) => Disposable;
  onDidRemove: (listener: (id: string) => void) => Disposable;
}

export interface AgentServiceDeps {
  ptyHost: Pick<UtilityHost<PtyHostMethods, PtyHostEvents>, 'onEvent'>;
  terminals: AgentTerminalsPort;
  registry?: Pick<ClaudeRegistry, 'get' | 'onDidChange' | 'hasClaudeAgents' | 'rescan'>;
  rules?: () => readonly AgentRule[];
  logger: Logger;
  now?: () => number;
  /** Heuristic tick; 0 disables the timer (tests call `tick()`). */
  tickMs?: number;
}

interface Tracked {
  id: string;
  projectId: string;
  /** Set for agent-profile terminals until the process monitor confirms the agent (max 10 s). */
  startingUntil?: number;
  profileAgent?: { agentId: string; displayName: string; provider: string };
  descendants: ProcInfo[];
  agent?: AgentInfo;
  /** Last update time per signal source (priority window). */
  sourceAt: Partial<Record<AgentStateSource, number>>;
  /** A source better than the output heuristic has spoken for this agent. */
  hasPreciseSource: boolean;
  lastOutputAt: number;
  workedAt?: number;
  /** Published kind (`shell` until the first confirmed classification). */
  kind: 'shell' | 'process' | 'agent';
  /** A new foreground process waiting to prove it is not a short-lived helper (shell start-up, prompt hooks). */
  pendingProcess?: { pid: number; since: number };
  /** Shell integration (M7-T5): a command is running; undefined without integration. */
  commandRunning?: boolean;
}

/**
 * Classifies terminals (shell / process / agent) from the PTY Host's process reports and derives each agent's
 * state from the Claude registry, OSC 9;4 progress, bells/notifications and output heuristics
 *.
 */
export class AgentService implements Disposable {
  private readonly tracked = new Map<string, Tracked>();
  private readonly store = new DisposableStore();
  private readonly emitter = new Emitter<AgentInfoWithTerminal[]>();
  readonly onDidUpdate = this.emitter.event;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: AgentServiceDeps) {
    this.now = deps.now ?? Date.now;
    const pty = deps.ptyHost;
    this.store.add(deps.terminals.onDidUpdate((info) => this.onTerminal(info)));
    this.store.add(deps.terminals.onDidRemove((id) => this.forget(id)));
    this.store.add(pty.onEvent('terminal:process', (e) => this.onProcesses(e.id, e.descendants)));
    this.store.add(pty.onEvent('terminal:progress', (e) => this.onProgress(e.id, e.state)));
    this.store.add(pty.onEvent('terminal:bell', (e) => this.signal(e.id, 'bell', 'waiting')));
    this.store.add(pty.onEvent('terminal:notification', (e) => this.signal(e.id, 'bell', 'waiting')));
    this.store.add(pty.onEvent('terminal:userInput', (e) => this.onUserInput(e.id)));
    this.store.add(pty.onEvent('terminal:command', (e) => this.onCommand(e.id, e.phase)));
    this.store.add(pty.onEvent('terminal:exit', (e) => this.onExit(e.id)));
    this.store.add(
      pty.onEvent('terminal:activity', (e) => {
        const t = this.tracked.get(e.id);
        if (t) t.lastOutputAt = e.lastOutputAt;
      }),
    );
    if (deps.registry) this.store.add(deps.registry.onDidChange(() => this.applyRegistry()));
    const tickMs = deps.tickMs ?? 1000;
    if (tickMs > 0) this.timer = setInterval(() => this.tick(), tickMs);
    for (const info of deps.terminals.list()) this.onTerminal(info);
  }

  private rules(): readonly AgentRule[] {
    return this.deps.rules?.() ?? DEFAULT_AGENT_RULES;
  }

  list(): AgentInfoWithTerminal[] {
    const out: AgentInfoWithTerminal[] = [];
    for (const t of this.tracked.values()) {
      if (t.agent) out.push({ ...t.agent, terminalId: t.id, projectId: t.projectId });
    }
    return out;
  }

  private onTerminal(info: TerminalInfo): void {
    if (this.tracked.has(info.id) || info.state !== 'running') return;
    const t: Tracked = {
      id: info.id,
      projectId: info.projectId,
      descendants: [],
      sourceAt: {},
      hasPreciseSource: false,
      lastOutputAt: 0,
      kind: info.kind,
    };
    this.tracked.set(info.id, t);
    if (info.kind === 'agent') {
      const rule = this.rules().find((r) => r.id === PROFILE_RULES[info.profileId]);
      t.profileAgent = rule
        ? { agentId: rule.id, displayName: rule.displayName, provider: rule.provider }
        : { agentId: info.profileId, displayName: info.profileName, provider: 'other' };
      t.startingUntil = this.now() + STARTING_MAX_MS;
      t.agent = {
        ...t.profileAgent,
        pid: info.pid ?? 0,
        state: 'starting',
        stateSource: 'none',
        since: this.now(),
      };
      this.publish(t, { kind: 'agent', agent: t.agent });
    }
  }

  private forget(id: string): void {
    const t = this.tracked.get(id);
    if (!t) return;
    this.tracked.delete(id);
    if (t.agent) this.fireAgents();
  }

  private onExit(id: string): void {
    const t = this.tracked.get(id);
    if (!t) return;
    this.tracked.delete(id);
    const hadAgent = t.agent !== undefined;
    this.deps.terminals.applyRuntime(id, { kind: 'shell', foreground: undefined, agent: undefined });
    if (hadAgent) this.fireAgents();
  }

  /** Shell integration command boundaries (OSC 633 C / D and prompts). */
  private onCommand(id: string, phase: 'prompt' | 'start' | 'end'): void {
    const t = this.tracked.get(id);
    if (!t) return;
    t.commandRunning = phase === 'start';
    // The next process report classifies the command (the current descendants may predate it).
    if (phase === 'start') return;
    t.pendingProcess = undefined;
    if (t.kind === 'process') this.publish(t, { kind: 'shell', foreground: undefined });
  }

  private onProcesses(id: string, descendants: ProcInfo[]): void {
    const t = this.tracked.get(id);
    if (!t) return;
    t.descendants = descendants;
    this.classify(t);
  }

  private classify(t: Tracked): void {
    const c = classifyTerminal(t.descendants, this.rules());
    const foreground =
      c.kind === 'shell'
        ? undefined
        : { pid: c.foreground.pid, name: c.foreground.name, commandLine: c.foreground.commandLine };
    if (c.kind === 'agent') {
      t.startingUntil = undefined;
      const prev = t.agent;
      const same = prev && prev.agentId === c.rule.id && prev.pid === c.proc.pid;
      t.agent = same
        ? prev
        : {
            agentId: c.rule.id,
            displayName: c.rule.displayName,
            provider: c.rule.provider,
            pid: c.proc.pid,
            state: 'unknown',
            stateSource: 'none',
            since: this.now(),
          };
      if (!same) {
        t.sourceAt = {};
        t.hasPreciseSource = false;
        t.workedAt = undefined;
        this.deps.logger.info(`Terminal ${t.id}: ${c.rule.displayName} detected (pid ${c.proc.pid})`);
        // Its registry entry may already exist (written at start-up): pick it up now.
        if (c.rule.id === 'claude-code') void this.deps.registry?.rescan();
      }
      this.updateRegistryFlag();
      this.applyRegistryTo(t);
      this.publish(t, { kind: 'agent', foreground, agent: t.agent });
      return;
    }
    // Agent profile still starting: keep "starting" until the agent shows up (max 10 s).
    if (t.startingUntil !== undefined && this.now() < t.startingUntil) return;
    t.startingUntil = undefined;
    if (c.kind === 'process' && t.kind === 'shell') {
      // With shell integration the boundaries are exact: at the prompt, descendants are prompt helpers
      // (e.g. `git status` in PS1); while a command runs, no confirmation delay is needed.
      if (t.commandRunning === false) return;
    }
    // A shell-named foreground may be a subshell of the shell's own hooks sampled just before the command ran:
    // it gets the normal confirmation delay even while a command runs.
    const instant =
      t.commandRunning === true && !SHELL_NAMES.has(c.kind === 'process' ? c.foreground.name.toLowerCase() : '');
    if (c.kind === 'process' && t.kind === 'shell' && !instant) {
      const pending = t.pendingProcess;
      if (!pending || pending.pid !== c.foreground.pid) t.pendingProcess = { pid: c.foreground.pid, since: this.now() };
      if (this.now() - t.pendingProcess!.since < PROCESS_CONFIRM_MS) return;
    }
    t.pendingProcess = undefined;
    const hadAgent = t.agent !== undefined;
    t.agent = undefined;
    this.publish(t, { kind: c.kind, foreground, agent: undefined });
    if (hadAgent) this.updateRegistryFlag();
  }

  /** Applies a state proposal from a source, honouring source priorities. Returns whether anything changed. */
  private propose(t: Tracked, source: AgentStateSource, state: AgentState, waitingFor?: string): boolean {
    const agent = t.agent;
    if (!agent || agent.state === 'starting') return false;
    const now = this.now();
    for (const [other, at] of Object.entries(t.sourceAt) as [AgentStateSource, number][]) {
      if (PRIORITY[other] > PRIORITY[source] && now - at < OVERRIDE_WINDOW_MS) {
        t.sourceAt[source] = now;
        return false;
      }
    }
    t.sourceAt[source] = now;
    if (source !== 'output-heuristic' && source !== 'none') t.hasPreciseSource = true;
    if (state === 'working') t.workedAt = now;
    if (agent.state === state && agent.stateSource === source && agent.waitingFor === waitingFor) return false;
    const { waitingFor: _w, ...rest } = agent;
    t.agent = {
      ...rest,
      state,
      stateSource: source,
      since: agent.state === state ? agent.since : now,
      ...(waitingFor ? { waitingFor } : {}),
    };
    return true;
  }

  private signal(id: string, source: AgentStateSource, state: AgentState): void {
    const t = this.tracked.get(id);
    if (t && this.propose(t, source, state)) this.publish(t, { agent: t.agent });
  }

  private onProgress(id: string, progress: number): void {
    const t = this.tracked.get(id);
    if (!t?.agent) return;
    // 1 (normal) / 3 (indeterminate) → working; 0 after work → idle; 4 (paused) → waiting (S5: unconfirmed).
    let state: AgentState | undefined;
    if (progress === 1 || progress === 3) state = 'working';
    else if (progress === 0 && t.workedAt !== undefined) state = 'idle';
    else if (progress === 4) state = 'waiting';
    if (state && this.propose(t, 'osc-progress', state)) this.publish(t, { agent: t.agent });
  }

  private onUserInput(id: string): void {
    const t = this.tracked.get(id);
    if (!t?.agent || t.agent.state !== 'waiting') return;
    // Optimistic: the user answered, the agent continues (keeps the source so priorities still hold).
    const { waitingFor: _w, ...rest } = t.agent;
    t.agent = { ...rest, state: 'working', since: this.now() };
    t.workedAt = this.now();
    this.publish(t, { agent: t.agent });
  }

  private updateRegistryFlag(): void {
    if (!this.deps.registry) return;
    this.deps.registry.hasClaudeAgents = [...this.tracked.values()].some((t) => t.agent?.agentId === 'claude-code');
  }

  private applyRegistry(): void {
    for (const t of this.tracked.values()) {
      if (this.applyRegistryTo(t)) this.publish(t, { agent: t.agent });
    }
  }

  private applyRegistryTo(t: Tracked): boolean {
    const agent = t.agent;
    if (!this.deps.registry || agent?.agentId !== 'claude-code' || agent.state === 'starting') return false;
    const entry: RegistryEntry | undefined = this.deps.registry.get(agent.pid);
    if (!entry) return false;
    let changed = false;
    const meta = {
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.name ? { sessionName: entry.name } : {}),
    };
    if (entry.sessionId !== agent.sessionId || entry.name !== agent.sessionName) {
      t.agent = { ...agent, ...meta };
      changed = true;
    }
    const state = mapRegistryStatus(entry.status);
    if (state !== 'unknown') changed = this.propose(t, 'claude-registry', state, entry.waitingFor) || changed;
    return changed;
  }

  /** Starting timeout and output heuristics (only for agents without a precise source). */
  tick(): void {
    const now = this.now();
    for (const t of this.tracked.values()) {
      if (
        (t.startingUntil !== undefined && now >= t.startingUntil) ||
        (t.pendingProcess && now - t.pendingProcess.since >= PROCESS_CONFIRM_MS)
      ) {
        this.classify(t);
        continue;
      }
      const agent = t.agent;
      if (!agent || agent.state === 'starting' || agent.state === 'waiting' || t.hasPreciseSource) continue;
      const sinceOutput = now - t.lastOutputAt;
      let state: AgentState | undefined;
      if (t.lastOutputAt > 0 && sinceOutput < OUTPUT_WORKING_MS) state = 'working';
      else if (agent.state === 'working' && sinceOutput > OUTPUT_IDLE_MS) state = 'idle';
      if (state && this.propose(t, 'output-heuristic', state)) this.publish(t, { agent: t.agent });
    }
  }

  private publish(t: Tracked, patch: TerminalRuntimePatch): void {
    if (patch.kind) t.kind = patch.kind;
    this.deps.terminals.applyRuntime(t.id, patch);
    this.fireAgents();
  }

  private fireAgents(): void {
    this.emitter.fire(this.list());
  }

  /**
   * A state reported by the agent itself (Claude Code hooks through the Bridge plugin): source `hook`, which wins
   * over every other source for 10 s. Its session id is authoritative.
   */
  reportState(terminalId: string, report: AgentStateReport): void {
    const t = this.tracked.get(terminalId);
    if (!t?.agent) return;
    let changed = false;
    if (report.sessionId && report.sessionId !== t.agent.sessionId) {
      t.agent = { ...t.agent, sessionId: report.sessionId };
      changed = true;
    }
    changed = this.propose(t, 'hook', report.state, report.waitingFor) || changed;
    if (changed) this.publish(t, { agent: t.agent });
  }

  /** A session id reported by a plugin (agents.annotate) — kept unless the registry already knows one. */
  reportSession(terminalId: string, sessionId: string): void {
    const t = this.tracked.get(terminalId);
    if (!t?.agent || t.agent.sessionId) return;
    t.agent = { ...t.agent, sessionId };
    this.publish(t, { agent: t.agent });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.store.dispose();
    this.emitter.dispose();
  }
}
