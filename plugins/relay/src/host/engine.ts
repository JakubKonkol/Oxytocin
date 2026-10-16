import type { AgentAccount, AgentLimits, AgentLimitWindow, AgentSnapshot } from '@oxytocin/plugin-api';
import {
  DEFAULT_CONFIG,
  type RelayConfig,
  type RelayLogEntry,
  type RelayParticipant,
  type RelayViewState,
} from '../shared/types';

/** A file of the working tree as git reports it (status and line counts), keyed by path. */
export type GitSnapshot = Map<string, string>;

export interface RelayDeps {
  /** Types a prompt into an idle agent (`oxy.agents.sendPrompt`). */
  send(terminalId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The project's changed files now; null: not a git repository. */
  gitSnapshot(projectId: string): Promise<GitSnapshot | null>;
  /** A hand-off or review happened (or could not): shown to the user. */
  notify(projectId: string, level: 'info' | 'warning', text: string): void;
  /** The view state of a project changed. */
  changed(projectId: string): void;
  now?: () => number;
}

/** An agent must stay idle this long before its turn counts as finished (states flicker between tool calls). */
export const SETTLE_MS = 3000;
/** A prompt that could not be sent, or an agent that just got one, is not tried again before this. */
export const RETRY_MS = 60_000;
const LOG_SIZE = 30;
const MAX_FILES_LISTED = 15;

const AGENT_SHORT: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', 'gemini-cli': 'Gemini' };
const ACCOUNT_AGENT: Record<string, AgentAccount['agent']> = {
  'claude-code': 'claude',
  codex: 'codex',
  'gemini-cli': 'gemini',
};

interface Tracker {
  projectId: string;
  state: AgentSnapshot['state'];
  /** Set while a turn runs (from "working" until it settles idle). */
  workingSince?: number;
  /** The working tree when the turn started (review mode). */
  turnStart?: Promise<GitSnapshot | null>;
  settle?: ReturnType<typeof setTimeout>;
  /** When a prompt could not be typed into it (it is not tried again for a while). */
  lastFailedAt?: number;
}

type Pending =
  | { kind: 'handoff'; from: string; reason: string; reported: boolean }
  | { kind: 'review'; from: string; files: string[]; reported: boolean };

/** The fuller of an account's time-based windows (the 5-hour or the weekly one), counting a reset window as 0. */
export function accountUsage(
  limits: AgentLimits | undefined,
  now: number,
): { percent: number; window: AgentLimitWindow } | null {
  let best: { percent: number; window: AgentLimitWindow } | null = null;
  for (const w of limits?.windows ?? []) {
    if (w.windowMinutes === null) continue;
    const percent = w.resetsAt !== null && w.resetsAt <= now ? 0 : w.usedPercent;
    if (!best || percent > best.percent) best = { percent, window: w };
  }
  return best;
}

const windowName = (w: AgentLimitWindow) =>
  w.windowMinutes === 300 ? '5-hour' : w.windowMinutes === 10080 ? 'weekly' : `${w.window}`;

/** Fills `{from}`, `{to}`, `{files}` and `{limit}` in a prompt. */
export function fillPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{(from|to|files|limit)\}/g, (m, key: string) => values[key] ?? m).trim();
}

/** Files that changed between two snapshots (new, different or gone — e.g. committed). */
export function changedFiles(start: GitSnapshot | null, end: GitSnapshot | null): string[] {
  if (!end) return [];
  if (!start) return [...end.keys()];
  const out = new Set<string>();
  for (const [path, value] of end) if (start.get(path) !== value) out.add(path);
  for (const path of start.keys()) if (!end.has(path)) out.add(path);
  return [...out].sort();
}

export function filesText(files: readonly string[]): string {
  if (files.length === 0) return 'see git status';
  const shown = files.slice(0, MAX_FILES_LISTED).join(', ');
  return files.length > MAX_FILES_LISTED ? `${shown} and ${files.length - MAX_FILES_LISTED} more` : shown;
}

/** Keeps a configuration within bounds (prompts, threshold) and fills what is missing with the defaults. */
export function normalizeConfig(raw: Partial<RelayConfig> | undefined): RelayConfig {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
  const prompt = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.slice(0, 4000) : fallback);
  return {
    enabled: c.enabled === true,
    mode: c.mode === 'review' ? 'review' : 'handoff',
    order: ids(c.order),
    excluded: ids(c.excluded),
    reviewer: typeof c.reviewer === 'string' ? c.reviewer : null,
    handoffPrompt: prompt(c.handoffPrompt, DEFAULT_CONFIG.handoffPrompt),
    reviewPrompt: prompt(c.reviewPrompt, DEFAULT_CONFIG.reviewPrompt),
    threshold: Math.min(100, Math.max(1, Math.round(Number(c.threshold) || DEFAULT_CONFIG.threshold))),
    onlyWithChanges: c.onlyWithChanges !== false,
  };
}

/**
 * Relay: hands a project's work from one AI agent to the next. It types one short prompt into an agent when its turn
 * is over and nothing else — no status messages, no diffs pasted (the agent reads the files itself), so the agents'
 * context and limits are spent on the work.
 *
 * - Hand-off: an agent finished its turn and its account's 5-hour (or weekly) limit is at least `threshold` full →
 *   the next idle agent in the order whose account still has room gets the hand-off prompt. Nobody free → it waits
 *   until someone is (e.g. the first agent again once its limit started over).
 * - Review: an author finished a turn that changed files → the reviewer gets the review prompt (turns that end while
 *   it is busy are reviewed together afterwards). The reviewer's own turns trigger nothing.
 */
export class RelayEngine {
  private readonly configs = new Map<string, RelayConfig>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly pending = new Map<string, Pending>();
  private readonly logs = new Map<string, RelayLogEntry[]>();
  private readonly sending = new Set<string>();
  private agents: AgentSnapshot[] = [];
  private limits: AgentLimits[] = [];
  private accounts: AgentAccount[] = [];
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: RelayDeps) {
    this.now = deps.now ?? Date.now;
  }

  config(projectId: string): RelayConfig {
    return this.configs.get(projectId) ?? DEFAULT_CONFIG;
  }

  setConfig(projectId: string, config: Partial<RelayConfig>): RelayConfig {
    const next = normalizeConfig(config);
    const before = this.configs.get(projectId);
    this.configs.set(projectId, next);
    // Switched off or to another mode: what was waiting no longer applies.
    if (!next.enabled || (before && before.mode !== next.mode)) this.pending.delete(projectId);
    this.deps.changed(projectId);
    return next;
  }

  setLimits(limits: AgentLimits[]): void {
    this.limits = limits;
    for (const projectId of this.projectIds()) this.deps.changed(projectId);
    void this.tryAllPending();
  }

  setAccounts(accounts: AgentAccount[]): void {
    this.accounts = accounts;
    for (const projectId of this.projectIds()) this.deps.changed(projectId);
  }

  /** The agents of every project and their states (`oxy.agents.onDidChange`). */
  update(agents: AgentSnapshot[]): void {
    const changedProjects = new Set<string>();
    const present = new Set(agents.map((a) => a.terminalId));
    for (const [id, t] of this.trackers)
      if (!present.has(id)) {
        clearTimeout(t.settle);
        this.trackers.delete(id);
        changedProjects.add(t.projectId);
        const p = this.pending.get(t.projectId);
        if (p?.from === id && p.kind === 'review') this.pending.delete(t.projectId);
      }
    for (const a of agents) {
      const t = this.trackers.get(a.terminalId) ?? { projectId: a.projectId, state: a.state };
      const previous = this.trackers.has(a.terminalId) ? t.state : undefined;
      t.projectId = a.projectId;
      if (previous !== a.state) changedProjects.add(a.projectId);
      if (a.state === 'working') {
        clearTimeout(t.settle);
        t.settle = undefined;
        if (t.workingSince === undefined) {
          t.workingSince = this.now();
          const config = this.config(a.projectId);
          if (config.enabled && config.mode === 'review' && config.reviewer !== a.terminalId)
            t.turnStart = this.deps.gitSnapshot(a.projectId).catch(() => null);
        }
      } else if (a.state === 'idle' && t.workingSince !== undefined && !t.settle) {
        t.settle = setTimeout(() => {
          t.settle = undefined;
          if (this.trackers.get(a.terminalId)?.state !== 'idle') return;
          // The agent is free now: what waits for it (a review, a hand-off) goes next.
          void this.turnFinished(a.terminalId).finally(() => void this.tryAllPending());
        }, SETTLE_MS);
      } else if (a.state !== 'idle') {
        // Waiting for the user (a permission, a question): the turn goes on after the answer.
        clearTimeout(t.settle);
        t.settle = undefined;
      }
      t.state = a.state;
      this.trackers.set(a.terminalId, t);
    }
    this.agents = agents;
    for (const projectId of changedProjects) this.deps.changed(projectId);
    void this.tryAllPending();
  }

  private projectIds(): Set<string> {
    return new Set([...this.configs.keys(), ...this.agents.map((a) => a.projectId)]);
  }

  private limitsOf(a: AgentSnapshot): AgentLimits | undefined {
    const agent = ACCOUNT_AGENT[a.agentId];
    if (!agent) return undefined;
    return this.limits.find((l) => l.agent === agent && l.accountId === (a.accountId ?? 'main'));
  }

  /** The project's agents in hand-off order, with their labels. */
  private ordered(projectId: string): { agent: AgentSnapshot; label: string }[] {
    const config = this.config(projectId);
    const agents = this.agents.filter((a) => a.projectId === projectId).sort((a, b) => a.since - b.since);
    const rank = (id: string) => {
      const i = config.order.indexOf(id);
      return i < 0 ? config.order.length : i;
    };
    const sorted = [...agents].sort((a, b) => rank(a.terminalId) - rank(b.terminalId));
    const base = (a: AgentSnapshot) => {
      const short = AGENT_SHORT[a.agentId];
      if (!short) return a.displayName;
      const id = a.accountId ?? 'main';
      const account = id === 'main' ? 'main' : (this.accounts.find((x) => x.id === id)?.name ?? id);
      return `${short} (${account})`;
    };
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(base(a), (counts.get(base(a)) ?? 0) + 1);
    const seen = new Map<string, number>();
    const numbers = new Map<string, number>();
    for (const a of agents) {
      const n = (seen.get(base(a)) ?? 0) + 1;
      seen.set(base(a), n);
      numbers.set(a.terminalId, n);
    }
    return sorted.map((agent) => ({
      agent,
      label: (counts.get(base(agent)) ?? 0) > 1 ? `${base(agent)} #${numbers.get(agent.terminalId)}` : base(agent),
    }));
  }

  private labelOf(projectId: string, terminalId: string): string {
    return this.ordered(projectId).find((p) => p.agent.terminalId === terminalId)?.label ?? 'the previous agent';
  }

  private log(projectId: string, level: RelayLogEntry['level'], text: string, notify = false): void {
    const list = [{ at: this.now(), level, text }, ...(this.logs.get(projectId) ?? [])].slice(0, LOG_SIZE);
    this.logs.set(projectId, list);
    if (notify) this.deps.notify(projectId, level, text);
    this.deps.changed(projectId);
  }

  private async turnFinished(terminalId: string): Promise<void> {
    const t = this.trackers.get(terminalId);
    const agent = this.agents.find((a) => a.terminalId === terminalId);
    if (!t || !agent) return;
    const turnStart = t.turnStart;
    t.workingSince = undefined;
    t.turnStart = undefined;
    const config = this.config(agent.projectId);
    if (!config.enabled || config.excluded.includes(terminalId)) return;
    const from = this.labelOf(agent.projectId, terminalId);
    if (config.mode === 'handoff') {
      const usage = accountUsage(this.limitsOf(agent), this.now());
      if (!usage || usage.percent < config.threshold) return;
      const reason = `${Math.round(usage.percent)}% of the ${windowName(usage.window)} limit`;
      this.log(agent.projectId, 'info', `${from} finished its turn at ${reason}.`);
      this.pending.set(agent.projectId, { kind: 'handoff', from: terminalId, reason, reported: false });
    } else {
      if (!config.reviewer || config.reviewer === terminalId) return;
      const start = turnStart ? await turnStart : null;
      const end = await this.deps.gitSnapshot(agent.projectId).catch(() => null);
      const files = changedFiles(start, end);
      // Without git (or a snapshot from the turn's start) Relay cannot tell: the turn is reviewed.
      if (config.onlyWithChanges && files.length === 0 && start && end) {
        this.log(agent.projectId, 'info', `${from} finished a turn without changing files: no review.`);
        return;
      }
      const previous = this.pending.get(agent.projectId);
      // Turns that end while the reviewer is busy are reviewed together.
      const merged = previous?.kind === 'review' ? [...new Set([...previous.files, ...files])].sort() : files;
      this.pending.set(agent.projectId, { kind: 'review', from: terminalId, files: merged, reported: false });
    }
    await this.tryPending(agent.projectId);
  }

  private async tryAllPending(): Promise<void> {
    for (const projectId of [...this.pending.keys()]) await this.tryPending(projectId);
  }

  private free(a: AgentSnapshot): boolean {
    const t = this.trackers.get(a.terminalId);
    if (a.state !== 'idle' || t?.workingSince !== undefined || t?.settle) return false;
    return t?.lastFailedAt === undefined || this.now() - t.lastFailedAt >= RETRY_MS;
  }

  private async tryPending(projectId: string): Promise<void> {
    const p = this.pending.get(projectId);
    const config = this.config(projectId);
    if (!p || !config.enabled || this.sending.has(projectId)) return;
    const ordered = this.ordered(projectId).filter((x) => !config.excluded.includes(x.agent.terminalId));
    const fromLabel = this.labelOf(projectId, p.from);
    let target: { agent: AgentSnapshot; label: string } | undefined;
    let text: string;
    if (p.kind === 'handoff') {
      // After the one that stopped, around the order; the one that stopped itself last (once its limit started over).
      const i = ordered.findIndex((x) => x.agent.terminalId === p.from);
      const rotation = i < 0 ? ordered : [...ordered.slice(i + 1), ...ordered.slice(0, i + 1)];
      target = rotation.find((x) => {
        if (!this.free(x.agent)) return false;
        const usage = accountUsage(this.limitsOf(x.agent), this.now());
        return !usage || usage.percent < config.threshold;
      });
      if (!target) {
        if (!p.reported) {
          p.reported = true;
          this.log(
            projectId,
            'warning',
            `No agent can take over from ${fromLabel} yet (the others are busy or at their limit): Relay waits.`,
            true,
          );
        }
        this.scheduleRetry();
        return;
      }
      text = fillPrompt(config.handoffPrompt, { from: fromLabel, to: target.label, limit: p.reason, files: '' });
    } else {
      target = ordered.find((x) => x.agent.terminalId === config.reviewer);
      if (!target) {
        this.pending.delete(projectId);
        return;
      }
      if (!this.free(target.agent)) {
        if (target.agent.state === 'idle') this.scheduleRetry();
        return;
      }
      text = fillPrompt(config.reviewPrompt, {
        from: fromLabel,
        to: target.label,
        files: filesText(p.files),
        limit: '',
      });
    }
    this.sending.add(projectId);
    try {
      const result = await this.deps.send(target.agent.terminalId, text);
      if (result.ok) {
        // Something newer may have replaced it while sending (another finished turn): keep that one.
        if (this.pending.get(projectId) === p) this.pending.delete(projectId);
        this.log(
          projectId,
          'info',
          p.kind === 'handoff'
            ? `Handed over from ${fromLabel} to ${target.label}.`
            : `Asked ${target.label} to review the changes of ${fromLabel}.`,
          true,
        );
      } else {
        const tracker = this.trackers.get(target.agent.terminalId);
        if (tracker) tracker.lastFailedAt = this.now();
        this.log(projectId, 'warning', `Could not send the prompt to ${target.label}: ${result.error}`, true);
        this.scheduleRetry();
      }
    } finally {
      this.sending.delete(projectId);
    }
  }

  private scheduleRetry(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.tryAllPending();
    }, RETRY_MS);
  }

  /** Types the mode's prompt into an agent now (the panel's "Send now"). */
  async sendNow(projectId: string, terminalId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const config = this.config(projectId);
    const ordered = this.ordered(projectId);
    const target = ordered.find((x) => x.agent.terminalId === terminalId);
    if (!target) return { ok: false, error: 'This agent is not running in the project.' };
    const previous = ordered[(ordered.indexOf(target) - 1 + ordered.length) % ordered.length];
    const from = previous && previous !== target ? previous.label : 'the previous agent';
    const text =
      config.mode === 'handoff'
        ? fillPrompt(config.handoffPrompt, { from, to: target.label, limit: 'its usage limit', files: '' })
        : fillPrompt(config.reviewPrompt, { from, to: target.label, files: 'see git status', limit: '' });
    const result = await this.deps.send(terminalId, text);
    this.log(
      projectId,
      result.ok ? 'info' : 'warning',
      result.ok
        ? `Sent the prompt to ${target.label}.`
        : `Could not send the prompt to ${target.label}: ${result.error}`,
    );
    return result;
  }

  view(projectId: string, projectName: string): RelayViewState {
    const config = this.config(projectId);
    const now = this.now();
    const participants: RelayParticipant[] = this.ordered(projectId).map(({ agent, label }) => {
      const usage = accountUsage(this.limitsOf(agent), now);
      return {
        terminalId: agent.terminalId,
        label,
        title: agent.displayName,
        state: agent.state,
        included: !config.excluded.includes(agent.terminalId),
        reviewer: config.reviewer === agent.terminalId,
        limit: usage
          ? {
              percent: Math.round(usage.percent),
              window: windowName(usage.window),
              resetsAt: usage.percent === 0 ? null : usage.window.resetsAt,
            }
          : null,
      };
    });
    const p = this.pending.get(projectId);
    return {
      projectId,
      projectName,
      config,
      participants,
      pending: p
        ? p.kind === 'handoff'
          ? `Waiting for an agent to take over from ${this.labelOf(projectId, p.from)}.`
          : 'Waiting for the reviewer to finish its turn.'
        : null,
      log: this.logs.get(projectId) ?? [],
      limitsKnown: this.limits.length > 0,
    };
  }

  dispose(): void {
    clearTimeout(this.retry);
    for (const t of this.trackers.values()) clearTimeout(t.settle);
  }
}
