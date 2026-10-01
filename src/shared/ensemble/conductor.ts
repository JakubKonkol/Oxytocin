import type {
  AdviceState,
  AdvisorMoment,
  AgentLive,
  AgentRunState,
  Assignment,
  EnsembleAgent,
  EnsembleRun,
  EnsembleTask,
  FinishAction,
  Handoff,
  Need,
  NeedKind,
  OutputKind,
  RunEvent,
  Stage,
  StageState,
  Submission,
  WorktreeInfo,
} from '../domain/ensemble';
import { OUTPUT_LABELS } from '../domain/ensemble';
import {
  assignmentMessage,
  defaultInstruction,
  DEFAULT_CHECKER_INSTRUCTION,
  formatFindings,
  handoffText,
  latestHandoff,
  MESSAGE_PREFIX,
  reminderMessage,
  resolveTemplate,
  safeMessage,
} from './prompts';

/**
 * The conductor: a pure state machine. `reduce(task, run, event)` returns the next run state and the effects to
 * execute (start an agent, type a message, run a command, commit a checkpoint…); their results come back as events.
 * Nothing here does I/O, so every pipeline rule is unit-testable.
 */

/** An agent idle this long after its delivery without submitting gets one reminder, then it needs the user. */
export const REMINDER_AFTER_MS = 20_000;
/** An agent that is not ready (idle) this long after its start needs the user (a trust or login prompt). */
export const READY_TIMEOUT_MS = 90_000;
/** Advice that does not come within this time is skipped. */
export const ADVICE_TIMEOUT_MS = 5 * 60_000;
/** Events kept in the run (older ones go to the artifacts folder). */
export const MAX_EVENTS = 1500;

export type ConductorEvent =
  | { type: 'start' }
  | { type: 'workspace-ready'; worktree: WorktreeInfo }
  | { type: 'workspace-failed'; error: string }
  | { type: 'agent-started'; agentId: string; terminalId: string; cliSessionId?: string | undefined }
  | { type: 'agent-start-failed'; agentId: string; error: string }
  | { type: 'agent-state'; agentId: string; state: AgentLive }
  | { type: 'delivered'; agentId: string; deliveryId: string }
  | { type: 'delivery-failed'; agentId: string; deliveryId: string; error: string }
  | { type: 'submit'; agentId: string; submission: Submission }
  | { type: 'mark-done'; agentId: string; summary: string }
  | { type: 'progress'; agentId: string; message: string; percent?: number | undefined }
  | { type: 'command-started'; stageId: string; terminalId: string }
  | { type: 'command-finished'; stageId: string; exitCode: number; output: string }
  | { type: 'checkpoint-done'; stageId: string; commit?: string | undefined; files?: number | undefined }
  | {
      type: 'gate';
      stageId: string;
      decision: 'approve' | 'reject' | 'stop';
      comment?: string | undefined;
      editedBody?: string | undefined;
    }
  | { type: 'resolve-need'; needId: string; action: string }
  | { type: 'ask'; from: string; to: string; question: string }
  | { type: 'answer'; by: string; questionId: string; answer: string; deliver: boolean }
  | { type: 'note'; by: string; text: string }
  | { type: 'message'; to: string; text: string }
  | { type: 'context-served'; agentId: string; items: string[] }
  | { type: 'take-over'; agentId: string }
  | { type: 'hand-back'; agentId: string }
  | { type: 'restart-agent'; agentId: string }
  | { type: 'advisor-enabled'; enabled: boolean }
  | { type: 'cost'; agentId: string; costUsd?: number | undefined; tokens?: number | undefined }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'interrupted' }
  | { type: 'resume-interrupted' }
  | { type: 'finished'; action: FinishAction; detail?: string | undefined }
  | { type: 'tick' };

export type Effect =
  | { type: 'prepare-workspace' }
  | { type: 'start-agent'; agentId: string; resume: boolean }
  | { type: 'deliver'; agentId: string; deliveryId: string; text: string }
  | { type: 'stop-agent'; agentId: string }
  | { type: 'stop-all' }
  | { type: 'run-command'; stageId: string; command: string; attempt: number }
  | { type: 'checkpoint'; stageId: string; message: string }
  | { type: 'notify'; title: string; body: string; level: 'info' | 'warning' | 'error' }
  | { type: 'question-answered'; questionId: string; answer: string };

export interface ReduceResult {
  run: EnsembleRun;
  effects: Effect[];
  /** For tool calls: the text returned to the agent. */
  reply?: string;
  /** For tool calls: the call is rejected with this message. */
  error?: string;
  /** For `ask`: the question's id. */
  questionId?: string;
}

/** A fresh run for a task (a draft, or the state before `start`). */
export function initialRun(task: EnsembleTask): EnsembleRun {
  return {
    v: 1,
    status: 'draft',
    stageIndex: 0,
    stages: task.pipeline.map((s) => ({ stageId: s.id, status: 'pending' })),
    agents: Object.fromEntries(task.agents.map((a) => [a.id, newAgentState(a.id)])),
    handoffs: [],
    questions: [],
    notes: [],
    needs: [],
    events: [],
    eventCount: 0,
    advice: [],
    advisorEnabled: true,
    checkpoints: [],
    activeMs: 0,
    seq: 0,
  };
}

function newAgentState(agentId: string): AgentRunState {
  return { agentId, lifecycle: 'not-started', takenOver: false, outbox: [], starts: 0, workedMs: 0 };
}

/** Running time of a run in ms. */
export function elapsedMs(run: EnsembleRun, now: number): number {
  return run.activeMs + (run.runningSince !== undefined ? Math.max(0, now - run.runningSince) : 0);
}

const stageAgents = (stage: Stage): string[] => {
  switch (stage.kind) {
    case 'agent':
      return [stage.agentId];
    case 'parallel':
      return stage.agentIds;
    case 'loop':
      return [stage.workerId, stage.checkerId];
    case 'command':
      return stage.onFail.agentId ? [stage.onFail.agentId] : [];
    case 'gate':
      return [];
  }
};

/** Agents a stage uses (for the flow view). */
export { stageAgents };

class Tx {
  readonly effects: Effect[] = [];
  reply?: string;
  error?: string;
  questionId?: string;

  constructor(
    readonly task: EnsembleTask,
    public run: EnsembleRun,
    readonly now: number,
  ) {}

  // ── helpers ──

  nextId(prefix: string): string {
    this.run.seq += 1;
    return `${prefix}-${this.run.seq}`;
  }

  agent(id: string): EnsembleAgent | undefined {
    return this.task.agents.find((a) => a.id === id);
  }

  agentName(id: string): string {
    if (id === 'user') return 'you';
    if (id === 'conductor') return 'the conductor';
    return this.agent(id)?.name ?? id;
  }

  state(id: string): AgentRunState {
    let s = this.run.agents[id];
    if (!s) {
      s = newAgentState(id);
      this.run.agents[id] = s;
    }
    return s;
  }

  stage(id: string): Stage | undefined {
    return this.task.pipeline.find((s) => s.id === id);
  }

  stageState(id: string): StageState {
    let s = this.run.stages.find((x) => x.stageId === id);
    if (!s) {
      s = { stageId: id, status: 'pending' };
      this.run.stages.push(s);
    }
    return s;
  }

  currentStage(): Stage | undefined {
    return this.task.pipeline[this.run.stageIndex];
  }

  log(e: Partial<RunEvent> & { type: RunEvent['type']; text: string }): void {
    this.run.eventCount += 1;
    this.run.events.push({ ...e, id: this.run.eventCount, at: this.now });
    if (this.run.events.length > MAX_EVENTS) this.run.events.splice(0, this.run.events.length - MAX_EVENTS);
  }

  /** A routing decision of the conductor (rule) or the user (you), shown in the decisions lane. */
  decide(what: string, inputs: string, outcome: string, extra: Partial<RunEvent> = {}, by: 'rule' | 'you' = 'rule') {
    this.log({ type: 'decision', text: what, inputs, outcome, by, ...extra });
  }

  need(kind: NeedKind, text: string, extra: Partial<Need> = {}): Need {
    const existing = this.run.needs.find(
      (n) => n.kind === kind && n.agentId === extra.agentId && n.stageId === extra.stageId && !extra.questionId,
    );
    if (existing) {
      existing.text = text;
      return existing;
    }
    const need: Need = { id: this.nextId('n'), kind, text, at: this.now, ...extra };
    this.run.needs.push(need);
    this.log({
      type: 'need',
      text,
      ...(extra.agentId ? { agentId: extra.agentId } : {}),
      ...(extra.stageId ? { stageId: extra.stageId } : {}),
    });
    return need;
  }

  clearNeeds(match: (n: Need) => boolean): void {
    this.run.needs = this.run.needs.filter((n) => !match(n));
  }

  notify(title: string, body: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.effects.push({ type: 'notify', title, body, level });
  }

  // ── run lifecycle ──

  start(): void {
    this.run = {
      ...initialRun(this.task),
      status: 'preparing',
      startedAt: this.now,
      eventCount: this.run.eventCount,
      seq: this.run.seq,
    };
    this.log({ type: 'run', text: `Started "${this.task.title}"` });
    this.effects.push({ type: 'prepare-workspace' });
  }

  setRunning(): void {
    this.run.status = 'running';
    this.run.runningSince ??= this.now;
    delete this.run.pauseReason;
  }

  setNotRunning(): void {
    if (this.run.runningSince !== undefined) {
      this.run.activeMs += Math.max(0, this.now - this.run.runningSince);
      delete this.run.runningSince;
    }
  }

  stopRun(reason: string, by: 'rule' | 'you' = 'you'): void {
    this.setNotRunning();
    this.run.status = 'stopped';
    this.run.endedAt = this.now;
    this.effects.push({ type: 'stop-all' });
    for (const s of Object.values(this.run.agents)) this.resetDelivery(s);
    this.cancelOpenQuestions();
    this.run.needs = [];
    this.log({ type: 'run', text: `Stopped: ${reason}`, by });
    if (this.run.worktree?.mode === 'worktree')
      this.need('finish', 'The task was stopped: keep, merge or discard its branch.');
  }

  cancelOpenQuestions(): void {
    for (const q of this.run.questions)
      if (q.answer === undefined) {
        q.answer = '(no answer: the task ended)';
        q.answeredAt = this.now;
        this.effects.push({ type: 'question-answered', questionId: q.id, answer: '' });
      }
  }

  resetDelivery(s: AgentRunState): void {
    if (s.assignment) delete s.assignment.delivering;
    for (const o of s.outbox) delete o.delivering;
  }

  finishRun(): void {
    if (this.adviseBeforeDone()) return;
    this.setNotRunning();
    this.run.status = 'done';
    this.run.endedAt = this.now;
    this.run.stageIndex = this.task.pipeline.length;
    this.effects.push({ type: 'stop-all' });
    this.log({ type: 'run', text: 'Every stage is done' });
    this.notify('Ensemble task done', `"${this.task.title}" finished all ${this.task.pipeline.length} stages.`);
    if (this.run.worktree?.mode === 'worktree')
      this.need('finish', 'The task is done: merge its branch, keep it, or discard it.');
  }

  // ── stages ──

  startStage(index: number, revision?: string): void {
    const stage = this.task.pipeline[index];
    if (!stage) {
      this.finishRun();
      return;
    }
    this.run.stageIndex = index;
    const st = this.stageState(stage.id);
    st.status = 'running';
    st.startedAt = this.now;
    delete st.endedAt;
    delete st.outcome;
    if (revision !== undefined) st.revision = revision;
    else delete st.revision;
    this.log({ type: 'stage', text: `Stage "${stage.title}" started`, stageId: stage.id });
    switch (stage.kind) {
      case 'agent': {
        if (stage.freshSession) this.freshSession(stage.agentId);
        const id = this.assign(stage.agentId, stage, stage.output, revision ? 'revision' : 'task', { revision });
        if (stage.output === 'plan') this.adviseBeforePlan(stage, [id]);
        break;
      }
      case 'parallel': {
        const ids = stage.agentIds.map((agentId) =>
          this.assign(agentId, stage, stage.output, revision ? 'revision' : 'task', { revision }),
        );
        if (stage.output === 'plan') this.adviseBeforePlan(stage, ids);
        break;
      }
      case 'loop':
        st.round = 1;
        st.phase = 'work';
        delete st.verdict;
        this.assign(stage.workerId, stage, 'implementation', revision ? 'revision' : 'task', {
          revision,
          round: 1,
          maxRounds: stage.maxRounds,
        });
        break;
      case 'gate':
        if (!this.adviseBeforeGate(stage)) this.openGate(stage);
        break;
      case 'command':
        st.phase = 'run';
        st.attempts = 1;
        delete st.exitCode;
        this.effects.push({ type: 'run-command', stageId: stage.id, command: stage.command, attempt: 1 });
        this.log({ type: 'command', text: `Running ${stage.command}`, stageId: stage.id });
        break;
    }
  }

  openGate(stage: Extract<Stage, { kind: 'gate' }>): void {
    const st = this.stageState(stage.id);
    st.status = 'waiting-gate';
    this.need('gate', `Approve "${stage.title}"`, { stageId: stage.id });
    this.notify('Ensemble needs your approval', `"${this.task.title}": ${stage.title}`, 'warning');
  }

  freshSession(agentId: string): void {
    const s = this.state(agentId);
    if (s.lifecycle === 'not-started') return;
    if (s.lifecycle === 'running' || s.lifecycle === 'starting') this.effects.push({ type: 'stop-agent', agentId });
    s.lifecycle = 'not-started';
    delete s.terminalId;
    delete s.cliSessionId;
    delete s.live;
    delete s.readyAt;
    this.decide(
      'fresh session',
      `stage option, ${this.agentName(agentId)}`,
      `→ new session for ${this.agentName(agentId)}`,
      {
        agentId,
      },
    );
  }

  /** Builds the full instruction of an assignment (variables resolved, inputs listed). */
  instructionFor(
    agentId: string,
    stage: Stage,
    output: OutputKind,
    kind: Assignment['kind'],
    o: { revision?: string | undefined; round?: number | undefined; maxRounds?: number | undefined; extra?: string },
  ): string {
    const agent = this.agent(agentId);
    const ctx = { task: this.task, run: this.run, agent, round: o.round, maxRounds: o.maxRounds, comment: o.revision };
    let template: string;
    if (stage.kind === 'loop' && agentId === stage.checkerId && kind === 'review')
      template = stage.checkerInstruction.trim() || DEFAULT_CHECKER_INSTRUCTION;
    else if (stage.kind === 'command') template = defaultInstruction('implementation');
    else template = stage.instruction.trim() || defaultInstruction(output);
    const parts: string[] = [];
    if (kind === 'revision' && o.revision)
      parts.push(
        `The user asked for changes to the earlier result of this stage:\n\n${o.revision}\n\nAddress them, then submit again.`,
      );
    if (o.extra) parts.push(o.extra);
    if (stage.kind !== 'command' || kind !== 'fix') parts.push(resolveTemplate(template, ctx));
    return parts.join('\n\n');
  }

  assign(
    agentId: string,
    stage: Stage,
    output: OutputKind,
    kind: Assignment['kind'],
    o: {
      revision?: string | undefined;
      round?: number | undefined;
      maxRounds?: number | undefined;
      extra?: string;
    } = {},
  ): string {
    const agent = this.agent(agentId);
    const s = this.state(agentId);
    const id = this.nextId('a');
    const assignment: Assignment = {
      id,
      stageId: stage.id,
      kind,
      output,
      createdAt: this.now,
      message: agent
        ? assignmentMessage({
            agent,
            stage,
            output,
            round: o.round,
            maxRounds: o.maxRounds,
            revision: kind === 'revision' || kind === 'fix',
          })
        : '',
      instruction: this.instructionFor(agentId, stage, output, kind, o),
      reminders: 0,
      ...(o.round ? { round: o.round } : {}),
    };
    if (stage.kind === 'parallel' && this.activeAssignments() >= this.task.limits.maxConcurrentAgents)
      assignment.queued = true;
    s.assignment = assignment;
    this.clearNeeds((n) => n.agentId === agentId && (n.kind === 'stuck' || n.kind === 'delivery-failed'));
    this.log({
      type: 'assigned',
      text: `${OUTPUT_LABELS[output]} → ${this.agentName(agentId)}${o.round ? ` (round ${o.round})` : ''}`,
      agentId,
      stageId: stage.id,
    });
    return id;
  }

  activeAssignments(): number {
    return Object.values(this.run.agents).filter((s) => s.assignment && !s.assignment.queued).length;
  }

  /** Queued assignments (parallel stages beyond the concurrency limit) start as others finish. */
  applyConcurrency(): void {
    const max = this.task.limits.maxConcurrentAgents;
    let active = this.activeAssignments();
    for (const s of Object.values(this.run.agents)) {
      if (active >= max) return;
      if (!s.assignment?.queued) continue;
      delete s.assignment.queued;
      active++;
    }
  }

  completeStage(stage: Stage, outcome: string): void {
    const st = this.stageState(stage.id);
    st.status = 'done';
    st.endedAt = this.now;
    st.outcome = outcome;
    this.log({ type: 'stage', text: `Stage "${stage.title}" done: ${outcome}`, stageId: stage.id });
    // Open assignments of this stage end with it (parallel "first", or marked as done by the user).
    for (const s of Object.values(this.run.agents))
      if (s.assignment?.stageId === stage.id && s.assignment.kind !== 'advice') {
        const delivered = s.assignment.deliveredAt !== undefined || s.assignment.delivering;
        delete s.assignment;
        this.clearNeeds((n) => n.agentId === s.agentId && n.kind === 'stuck');
        if (delivered)
          this.enqueue(
            s.agentId,
            'notice',
            `${MESSAGE_PREFIX} The stage "${stage.title}" is complete without your result: stop working on it and wait for a new assignment.`,
          );
      }
    this.clearNeeds((n) => n.stageId === stage.id && n.kind !== 'finish');
    const writes =
      this.run.worktree?.mode === 'worktree' &&
      stage.kind !== 'gate' &&
      stageAgents(stage).some((id) => !this.agent(id)?.readOnly);
    if (writes) {
      this.run.pendingCheckpoint = stage.id;
      const who = stageAgents(stage)
        .map((id) => this.agentName(id))
        .join(', ');
      this.effects.push({
        type: 'checkpoint',
        stageId: stage.id,
        message: `ensemble: ${stage.title}${who ? ` (${who})` : ''}`,
      });
      return;
    }
    this.advance(stage);
  }

  advance(from: Stage): void {
    const index = this.task.pipeline.findIndex((s) => s.id === from.id);
    const next = this.task.pipeline[index + 1];
    this.decide(
      'next stage',
      `"${from.title}" done`,
      next ? `→ ${next.title}${this.describeTarget(next)}` : '→ finish',
      { stageId: from.id },
    );
    if (next) this.startStage(index + 1);
    else this.finishRun();
  }

  describeTarget(stage: Stage): string {
    if (stage.kind === 'gate') return ' (your approval)';
    if (stage.kind === 'command') return ` (${stage.command})`;
    const names = stage.kind === 'loop' ? [stage.workerId] : stageAgents(stage);
    return names.length ? ` (${names.map((id) => this.agentName(id)).join(', ')})` : '';
  }

  // ── submissions ──

  submit(agentId: string, sub: Submission, by: 'agent' | 'user'): void {
    const s = this.run.agents[agentId];
    const assignment = s?.assignment;
    if (!s || !assignment) {
      this.error =
        'You have no open assignment right now. Oxytocin will send you a message when there is work for you; until then wait.';
      return;
    }
    if (sub.kind !== assignment.output) {
      this.error = `This assignment expects kind "${assignment.output}" (${OUTPUT_LABELS[assignment.output]}), not "${sub.kind}". Submit again with kind "${assignment.output}".`;
      return;
    }
    if (sub.kind === 'review') {
      if (!sub.verdict) {
        this.error = 'A review needs `verdict`: "approve" or "changes".';
        return;
      }
      if (sub.verdict === 'changes' && !sub.findings?.length) {
        this.error = 'A review with verdict "changes" needs `findings` (file, line, severity, message) for the author.';
        return;
      }
    }
    const handoff: Handoff = {
      id: this.nextId('h'),
      stageId: assignment.stageId,
      agentId,
      kind: sub.kind,
      summary: sub.summary,
      ...(sub.body ? { body: sub.body } : {}),
      ...(sub.verdict ? { verdict: sub.verdict } : {}),
      ...(sub.findings ? { findings: sub.findings } : {}),
      ...(sub.files ? { files: sub.files } : {}),
      ...(sub.target ? { target: sub.target } : {}),
      ...(assignment.round ? { round: assignment.round } : {}),
      at: this.now,
      by,
    };
    this.run.handoffs.push(handoff);
    delete s.assignment;
    this.clearNeeds((n) => n.agentId === agentId && (n.kind === 'stuck' || n.kind === 'delivery-failed'));
    this.log({
      type: 'submitted',
      text: `${this.agentName(agentId)} submitted ${OUTPUT_LABELS[sub.kind].toLowerCase()}: ${sub.summary.slice(0, 200)}`,
      agentId,
      stageId: assignment.stageId,
      handoffId: handoff.id,
      by: by === 'user' ? 'you' : 'agent',
    });
    if (assignment.kind === 'advice') {
      this.onAdvice(agentId, assignment, handoff);
      return;
    }
    const stage = this.stage(assignment.stageId);
    if (!stage || this.currentStage()?.id !== stage.id || this.stageState(stage.id).status !== 'running') {
      this.reply = 'Thanks — the stage already ended; your result was kept for the team.';
      return;
    }
    this.reply = this.onSubmitted(stage, agentId, handoff);
  }

  onSubmitted(stage: Stage, agentId: string, h: Handoff): string {
    const st = this.stageState(stage.id);
    switch (stage.kind) {
      case 'agent':
        this.completeStage(stage, h.summary.slice(0, 120));
        return this.nextText();
      case 'parallel': {
        const waiting = stage.agentIds.filter((id) => this.run.agents[id]?.assignment?.stageId === stage.id);
        if (stage.join === 'first' || waiting.length === 0) {
          this.decide(
            'parallel join',
            `${stage.join === 'first' ? 'first result' : `all ${stage.agentIds.length} results`} in`,
            '→ stage done',
            { stageId: stage.id },
          );
          this.completeStage(stage, `${stage.agentIds.length - waiting.length}/${stage.agentIds.length} submitted`);
          return this.nextText();
        }
        return `Thanks. Waiting for ${waiting.map((id) => this.agentName(id)).join(', ')} before the team moves on.`;
      }
      case 'loop': {
        const round = st.round ?? 1;
        if (agentId === stage.workerId && st.phase === 'work') {
          st.phase = 'check';
          this.decide(
            'handoff',
            `${this.agentName(agentId)} submitted (round ${round})`,
            `→ review by ${this.agentName(stage.checkerId)}`,
            { stageId: stage.id, agentId: stage.checkerId },
          );
          this.assign(stage.checkerId, stage, 'review', 'review', { round, maxRounds: stage.maxRounds });
          return `Handed to ${this.agentName(stage.checkerId)} for review (round ${round}/${stage.maxRounds}). Wait for the findings.`;
        }
        if (agentId === stage.checkerId && st.phase === 'check') {
          st.verdict = h.verdict;
          if (h.verdict === 'approve') {
            this.decide('review verdict', `approve, round ${round}`, '→ stage done', { stageId: stage.id });
            this.completeStage(stage, `approved in round ${round}`);
            return this.nextText();
          }
          const findings = h.findings?.length ?? 0;
          st.outcome = `${findings} finding${findings === 1 ? '' : 's'}`;
          if (round < stage.maxRounds + this.extraRounds(st)) {
            st.round = round + 1;
            st.phase = 'work';
            this.decide(
              'review verdict',
              `changes, ${findings} finding${findings === 1 ? '' : 's'}, round ${round}/${stage.maxRounds}`,
              `→ back to ${this.agentName(stage.workerId)}`,
              { stageId: stage.id, agentId: stage.workerId },
            );
            this.assign(stage.workerId, stage, 'implementation', 'fix', {
              round: round + 1,
              maxRounds: stage.maxRounds,
              extra: `${this.agentName(agentId)} reviewed your work (round ${round}) and asks for changes:\n\n${formatFindings(h.findings)}\n\n${h.body?.trim() ? `${h.body.trim()}\n\n` : ''}Fix them in your session, then submit with kind "implementation" again.`,
            });
            return `Thanks. ${this.agentName(stage.workerId)} gets your ${findings} finding${findings === 1 ? '' : 's'} and will fix them; you will review again.`;
          }
          this.decide('review verdict', `changes after ${round} rounds`, '→ needs you', { stageId: stage.id });
          this.need('loop-limit', `"${stage.title}" reached ${round} rounds and the review still asks for changes`, {
            stageId: stage.id,
          });
          this.notify('Ensemble needs you', `"${stage.title}" reached its round limit.`, 'warning');
          return 'Thanks. The round limit is reached; the user decides how to continue.';
        }
        return 'Thanks — your result was kept.';
      }
      case 'command': {
        if (st.phase === 'fix') {
          st.phase = 'run';
          st.attempts = (st.attempts ?? 1) + 1;
          this.decide(
            'fix submitted',
            `${this.agentName(agentId)}: ${h.summary.slice(0, 80)}`,
            `→ run ${stage.command} again`,
            {
              stageId: stage.id,
            },
          );
          this.effects.push({ type: 'run-command', stageId: stage.id, command: stage.command, attempt: st.attempts });
          this.log({ type: 'command', text: `Running ${stage.command} (attempt ${st.attempts})`, stageId: stage.id });
          return `Thanks. Oxytocin runs \`${stage.command}\` again.`;
        }
        return 'Thanks — your result was kept.';
      }
      case 'gate':
        return 'Thanks — your result was kept.';
    }
  }

  extraRounds(st: StageState): number {
    return st.extraRounds ?? 0;
  }

  nextText(): string {
    const next = this.currentStage();
    if (this.run.status === 'done') return 'Thanks — that was the last stage; the task is done.';
    if (this.run.pendingCheckpoint) return 'Thanks — Oxytocin saves a checkpoint and hands the work on.';
    if (!next) return 'Thanks.';
    return `Thanks — next: "${next.title}"${this.describeTarget(next)}.`;
  }

  // ── commands ──

  commandFinished(stageId: string, exitCode: number, output: string): void {
    const stage = this.stage(stageId);
    if (!stage || stage.kind !== 'command') return;
    const st = this.stageState(stageId);
    if (st.status !== 'running' || st.phase !== 'run') return;
    st.exitCode = exitCode;
    const attempt = st.attempts ?? 1;
    const tail = output.length > 12_000 ? `…${output.slice(-12_000)}` : output;
    this.run.handoffs.push({
      id: this.nextId('h'),
      stageId,
      agentId: 'conductor',
      kind: 'test-report',
      summary: `${stage.command}: ${exitCode === 0 ? 'passed' : `exit code ${exitCode}`} (attempt ${attempt})`,
      body: tail,
      at: this.now,
      by: 'conductor',
    });
    this.log({
      type: 'command',
      text: `${stage.command} ${exitCode === 0 ? 'passed' : `failed (exit ${exitCode})`}`,
      stageId,
    });
    if (exitCode === 0) {
      this.decide('command result', `${stage.command} exit 0 (attempt ${attempt})`, '→ stage done', { stageId });
      this.completeStage(stage, attempt > 1 ? `passed after ${attempt} attempts` : 'passed');
      return;
    }
    st.outcome = `exit ${exitCode}`;
    const fixes = attempt - 1;
    const fixer = stage.onFail.agentId;
    if (fixer && fixes < stage.onFail.maxAttempts) {
      st.phase = 'fix';
      this.decide(
        'command failed',
        `${stage.command} exit ${exitCode} (${attempt}/${stage.onFail.maxAttempts + 1})`,
        `→ back to ${this.agentName(fixer)}`,
        { stageId, agentId: fixer },
      );
      const id = this.assign(fixer, stage, 'implementation', 'fix', {
        extra: `\`${stage.command}\` failed with exit code ${exitCode} (attempt ${attempt}). Find the cause and fix it, then submit with kind "implementation"; Oxytocin runs the command again.\n\nOutput (last part):\n\n\`\`\`\n${tail.slice(-6000)}\n\`\`\``,
      });
      if (attempt >= 2) this.adviseRepeatedError(stage, fixer, id, tail);
      return;
    }
    this.decide('command failed', `${stage.command} exit ${exitCode}, no attempts left`, '→ needs you', { stageId });
    this.need('command-failed', `${stage.command} failed (exit ${exitCode})`, { stageId });
    this.notify('Ensemble needs you', `${stage.command} failed in "${this.task.title}".`, 'warning');
  }

  // ── gates ──

  gate(stageId: string, decision: 'approve' | 'reject' | 'stop', comment?: string, editedBody?: string): void {
    const stage = this.stage(stageId);
    const st = this.stageState(stageId);
    if (!stage || stage.kind !== 'gate' || st.status !== 'waiting-gate') {
      this.error = 'This gate is not open.';
      return;
    }
    this.clearNeeds((n) => n.kind === 'gate' && n.stageId === stageId);
    if (decision === 'stop') {
      this.log({ type: 'gate', text: `${stage.title}: stopped`, stageId, by: 'you' });
      this.stopRun(`at the gate "${stage.title}"`);
      return;
    }
    if (decision === 'approve') {
      if (editedBody?.trim()) {
        const plan = latestHandoff(this.run, 'plan');
        this.run.handoffs.push({
          id: this.nextId('h'),
          stageId,
          agentId: 'user',
          kind: plan?.kind ?? 'plan',
          summary: 'Edited and approved by the user',
          body: editedBody,
          at: this.now,
          by: 'user',
        });
      }
      this.log({ type: 'gate', text: `${stage.title}: approved${editedBody ? ' (edited)' : ''}`, stageId, by: 'you' });
      this.decide('gate', `${stage.title}: approved`, '→ next stage', { stageId }, 'you');
      st.status = 'done';
      st.endedAt = this.now;
      st.outcome = 'approved';
      this.advance(stage);
      return;
    }
    const text = comment?.trim() || 'The user rejected the result without a comment.';
    this.log({ type: 'gate', text: `${stage.title}: changes requested — ${text.slice(0, 200)}`, stageId, by: 'you' });
    if (stage.onReject === 'stop') {
      this.stopRun(`rejected at "${stage.title}"`);
      return;
    }
    const index = this.task.pipeline.findIndex((s) => s.id === stageId);
    let back = index - 1;
    while (back >= 0 && this.task.pipeline[back]!.kind === 'gate') back--;
    if (back < 0) {
      this.decide('gate', `${stage.title}: rejected, nothing before it`, '→ stopped', { stageId }, 'you');
      this.stopRun(`rejected at "${stage.title}"`);
      return;
    }
    for (let i = back; i <= index; i++) {
      const s = this.stageState(this.task.pipeline[i]!.id);
      s.status = 'pending';
      delete s.outcome;
    }
    const target = this.task.pipeline[back]!;
    this.decide(
      'gate',
      `${stage.title}: rejected`,
      `→ back to "${target.title}"${this.describeTarget(target)}`,
      { stageId },
      'you',
    );
    this.startStage(back, text);
  }

  // ── advisor ──

  advisorAvailable(moment: AdvisorMoment): string | undefined {
    const a = this.task.advisor;
    if (!a || !this.run.advisorEnabled || !a.moments.includes(moment)) return undefined;
    if (!this.agent(a.agentId)) return undefined;
    const used = this.run.advice.filter((x) => x.status !== 'failed').length;
    if (used >= a.maxInterventions) return undefined;
    if (this.run.agents[a.agentId]?.assignment) return undefined;
    return a.agentId;
  }

  consult(
    moment: AdvisorMoment,
    stage: Stage,
    question: string,
    target: string,
    digest: string,
  ): AdviceState | undefined {
    const advisorId = this.advisorAvailable(moment);
    if (!advisorId) return undefined;
    const advice: AdviceState = {
      id: this.nextId('adv'),
      moment,
      question,
      target,
      stageId: stage.id,
      status: 'asked',
      at: this.now,
    };
    this.run.advice.push(advice);
    const targetName = target === 'user' ? 'user' : this.agentName(target);
    const advisor = this.agent(advisorId)!;
    const s = this.state(advisorId);
    const id = this.nextId('a');
    s.assignment = {
      id,
      stageId: stage.id,
      kind: 'advice',
      output: 'advice',
      createdAt: this.now,
      message: `${MESSAGE_PREFIX} ${advisor.name}, you are consulted (${MOMENT_LABELS[moment]}): ${question} Call oxy_ensemble_context for the details, then call oxy_ensemble_submit with kind "advice" and target "${targetName}".`,
      instruction: `${defaultInstruction('advice')}\n\nMoment: ${MOMENT_LABELS[moment]} — ${question}\nThe advice is for: ${targetName}.\n\n${digest}`,
      reminders: 0,
      adviceId: advice.id,
    };
    this.decide(
      'advisor moment',
      `${MOMENT_LABELS[moment]}, ${question}`,
      `→ ${advisor.name} (advice for ${targetName})`,
      { stageId: stage.id, agentId: advisorId },
    );
    return advice;
  }

  adviseBeforePlan(stage: Stage, assignmentIds: string[]): void {
    const planners = Object.values(this.run.agents).filter(
      (s) => s.assignment && assignmentIds.includes(s.assignment.id),
    );
    const target = planners[0]?.agentId;
    if (!target) return;
    const advice = this.consult(
      'before-plan',
      stage,
      'Right approach?',
      target,
      `The planner ${this.agentName(target)} is about to plan:\n\n${this.task.description.slice(0, 6000)}`,
    );
    if (!advice) return;
    for (const p of planners) p.assignment!.waitingForAdvice = advice.id;
  }

  adviseRepeatedError(stage: Stage, fixer: string, assignmentId: string, output: string): void {
    const advice = this.consult(
      'repeated-error',
      stage,
      'Wrong place? Stop retrying?',
      fixer,
      `The command \`${stage.kind === 'command' ? stage.command : ''}\` failed again. Last output:\n\n\`\`\`\n${output.slice(-4000)}\n\`\`\``,
    );
    if (!advice) return;
    const a = this.run.agents[fixer]?.assignment;
    if (a?.id === assignmentId) a.waitingForAdvice = advice.id;
  }

  adviseBeforeGate(stage: Extract<Stage, { kind: 'gate' }>): boolean {
    const latest = this.run.handoffs.filter((h) => h.by !== 'conductor').at(-1);
    const advice = this.consult(
      'before-gate',
      stage,
      'What should the user look at?',
      'user',
      `The user is about to approve "${stage.title}". The latest result:\n\n${latest ? `${latest.summary}\n\n${handoffText(latest).slice(0, 6000)}` : '(none)'}`,
    );
    return advice !== undefined;
  }

  adviseBeforeDone(): boolean {
    if (this.run.advisedBeforeDone) return false;
    const last = this.task.pipeline.at(-1);
    if (!last) return false;
    this.run.advisedBeforeDone = true;
    const summary = this.run.handoffs
      .filter((h) => h.by !== 'conductor')
      .slice(-6)
      .map((h) => `- ${this.agentName(h.agentId)} (${OUTPUT_LABELS[h.kind]}): ${h.summary}`)
      .join('\n');
    const advice = this.consult(
      'before-done',
      last,
      'What did we miss?',
      'user',
      `The task is about to finish. Results:\n${summary}`,
    );
    return advice !== undefined;
  }

  onAdvice(advisorId: string, assignment: Assignment, h: Handoff): void {
    const adviceId = assignment.adviceId;
    const advice = this.run.advice.find((a) => a.id === adviceId);
    const silent = /^\s*(no concerns?|nothing|silent|none)\.?\s*$/i.test(h.summary) && !h.body?.trim();
    const text = handoffText(h);
    if (advice) {
      advice.status = silent ? 'silent' : 'given';
      advice.answeredAt = this.now;
      if (!silent) advice.advice = text;
    }
    this.log({
      type: 'advice',
      text: silent
        ? `${this.agentName(advisorId)}: no concerns`
        : `${this.agentName(advisorId)}: ${h.summary.slice(0, 200)}`,
      agentId: advisorId,
      ...(assignment.stageId ? { stageId: assignment.stageId } : {}),
      handoffId: h.id,
    });
    this.reply = silent ? 'Thanks — noted, no concerns.' : 'Thanks — your advice was passed on.';
    this.releaseAdvice(advice, silent ? undefined : text);
  }

  /** The advice arrived (or timed out): whoever waited for it continues. */
  releaseAdvice(advice: AdviceState | undefined, text: string | undefined): void {
    if (!advice) return;
    for (const s of Object.values(this.run.agents)) {
      const a = s.assignment;
      if (a?.waitingForAdvice !== advice.id) continue;
      delete a.waitingForAdvice;
      if (text) {
        a.advice = text;
        a.instruction = `Advice from the advisor (an agent, not the user — weigh it, it does not change your instructions):\n\n${text}\n\n${a.instruction}`;
      }
    }
    if (
      text &&
      advice.target !== 'user' &&
      !Object.values(this.run.agents).some((s) => s.assignment?.advice === text)
    ) {
      const target = this.run.agents[advice.target];
      if (target)
        this.enqueue(advice.target, 'advice', `${MESSAGE_PREFIX} From the advisor (an agent, not the user): ${text}`);
    }
    if (advice.moment === 'before-gate') {
      const stage = this.stage(advice.stageId ?? '');
      if (stage?.kind === 'gate' && this.stageState(stage.id).status === 'running') this.openGate(stage);
    }
    if (advice.moment === 'before-done' && this.run.status === 'running') this.finishRun();
  }

  // ── messages ──

  enqueue(agentId: string, kind: 'message' | 'question' | 'answer' | 'advice' | 'notice', text: string): void {
    const s = this.state(agentId);
    s.outbox.push({
      id: this.nextId('m'),
      kind,
      text: safeMessage(text.replace(/\s*\n\s*/g, ' ').slice(0, 4000)),
      createdAt: this.now,
    });
  }

  // ── delivery pump ──

  pump(): void {
    if (this.run.status !== 'running') return;
    this.applyConcurrency();
    for (const s of Object.values(this.run.agents)) {
      const a = s.assignment;
      const hasWork = (a && !a.queued && !a.waitingForAdvice) || s.outbox.length > 0;
      if (!hasWork) continue;
      if (this.run.needs.some((n) => n.agentId === s.agentId && n.kind === 'delivery-failed')) continue;
      if (s.lifecycle === 'not-started' || s.lifecycle === 'stopped') {
        const resume = s.lifecycle === 'stopped' && !!s.cliSessionId;
        s.lifecycle = 'starting';
        s.starts += 1;
        s.startedAt = this.now;
        delete s.readyAt;
        delete s.live;
        delete s.error;
        this.effects.push({ type: 'start-agent', agentId: s.agentId, resume });
        this.log({
          type: 'state',
          text: `Starting ${this.agentName(s.agentId)}${resume ? ' (resuming its session)' : ''}`,
          agentId: s.agentId,
          state: 'starting',
        });
        continue;
      }
      if (s.lifecycle !== 'running' || s.live !== 'idle' || s.takenOver) continue;
      if (a?.delivering || s.outbox.some((o) => o.delivering)) continue;
      if (a && !a.queued && !a.waitingForAdvice && a.deliveredAt === undefined) {
        a.delivering = true;
        this.effects.push({ type: 'deliver', agentId: s.agentId, deliveryId: a.id, text: a.message });
        continue;
      }
      const item = s.outbox[0];
      if (item) {
        item.delivering = true;
        this.effects.push({ type: 'deliver', agentId: s.agentId, deliveryId: item.id, text: item.text });
      }
    }
  }

  // ── timers ──

  tick(): void {
    if (this.run.status !== 'running') return;
    const limits = this.task.limits;
    if (!this.run.limitOverride) {
      if (limits.maxDurationMin && elapsedMs(this.run, this.now) > limits.maxDurationMin * 60_000) {
        this.pauseFor(`The time limit of ${limits.maxDurationMin} min is reached`);
        return;
      }
      if (limits.maxCostUsd && (this.run.costUsd ?? 0) > limits.maxCostUsd) {
        this.pauseFor(`The budget of $${limits.maxCostUsd} is reached`);
        return;
      }
    }
    for (const s of Object.values(this.run.agents)) {
      const a = s.assignment;
      if (
        (s.lifecycle === 'starting' || s.lifecycle === 'running') &&
        s.readyAt === undefined &&
        s.startedAt !== undefined
      ) {
        if (this.now - s.startedAt > READY_TIMEOUT_MS)
          this.need(
            'not-ready',
            `${this.agentName(s.agentId)} is not ready: open its terminal (a folder trust, login or update prompt may be waiting)`,
            { agentId: s.agentId },
          );
      }
      if (!a || s.takenOver || a.deliveredAt === undefined || a.idleSince === undefined) continue;
      if (s.live !== 'idle' || a.delivering || s.outbox.some((o) => o.delivering)) continue;
      if (this.now - a.idleSince < REMINDER_AFTER_MS) continue;
      if (a.reminders === 0) {
        a.reminders = 1;
        delete a.idleSince;
        const agent = this.agent(s.agentId);
        if (agent) this.enqueue(s.agentId, 'notice', reminderMessage(agent, a.output));
        this.log({ type: 'reminder', text: `Reminded ${this.agentName(s.agentId)} to submit`, agentId: s.agentId });
        this.decide('agent idle', `no submit after ${REMINDER_AFTER_MS / 1000} s`, '→ reminder sent', {
          agentId: s.agentId,
        });
      } else if (!this.run.needs.some((n) => n.kind === 'stuck' && n.agentId === s.agentId)) {
        this.decide('agent idle', 'no submit after a reminder', '→ needs you', { agentId: s.agentId });
        this.need(
          'stuck',
          `${this.agentName(s.agentId)} stopped without submitting: answer it in its terminal or mark it as done`,
          {
            agentId: s.agentId,
          },
        );
        this.notify(
          'Ensemble needs you',
          `${this.agentName(s.agentId)} stopped without finishing its part.`,
          'warning',
        );
      }
    }
    for (const advice of this.run.advice) {
      if (advice.status !== 'asked' || this.now - advice.at < ADVICE_TIMEOUT_MS) continue;
      advice.status = 'failed';
      const advisorId = this.task.advisor?.agentId;
      const s = advisorId ? this.run.agents[advisorId] : undefined;
      if (s?.assignment?.kind === 'advice') delete s.assignment;
      this.decide('advisor timeout', `no advice after ${ADVICE_TIMEOUT_MS / 60_000} min`, '→ continue without it');
      this.releaseAdvice(advice, undefined);
    }
  }

  pauseFor(reason: string): void {
    this.setNotRunning();
    this.run.status = 'paused';
    this.run.pauseReason = reason;
    this.need('limit', reason);
    this.notify('Ensemble paused', `${reason} ("${this.task.title}").`, 'warning');
  }

  // ── agent states ──

  agentState(agentId: string, state: AgentLive): void {
    const s = this.run.agents[agentId];
    if (!s || s.lifecycle === 'not-started' || s.lifecycle === 'stopped') return;
    const before = s.live;
    if (before === state) return;
    if (before === 'working' && s.liveSince !== undefined) s.workedMs += Math.max(0, this.now - s.liveSince);
    s.live = state;
    s.liveSince = this.now;
    if (state === 'working' || state === 'idle' || state === 'waiting' || state === 'exited')
      this.log({ type: 'state', text: `${this.agentName(agentId)} ${STATE_TEXT[state]}`, agentId, state });
    if (state !== 'waiting') this.clearNeeds((n) => n.agentId === agentId && n.kind === 'permission');
    const a = s.assignment;
    switch (state) {
      case 'idle':
        if (s.readyAt === undefined) {
          s.readyAt = this.now;
          this.clearNeeds((n) => n.agentId === agentId && n.kind === 'not-ready');
        }
        if (a?.deliveredAt !== undefined && !a.delivering) a.idleSince = this.now;
        break;
      case 'working':
        if (a) delete a.idleSince;
        this.clearNeeds((n) => n.agentId === agentId && n.kind === 'stuck');
        if (s.readyAt === undefined) {
          s.readyAt = this.now;
          this.clearNeeds((n) => n.agentId === agentId && n.kind === 'not-ready');
        }
        break;
      case 'waiting':
        this.need('permission', `${this.agentName(agentId)} waits for your answer in its terminal`, { agentId });
        break;
      case 'exited':
        s.lifecycle = 'exited';
        this.resetDelivery(s);
        if (a || s.outbox.length)
          this.need('exited', `${this.agentName(agentId)}'s CLI exited: restart it`, { agentId });
        break;
      default:
        break;
    }
  }
}

const STATE_TEXT: Record<AgentLive, string> = {
  starting: 'is starting',
  working: 'is working',
  idle: 'is idle',
  waiting: 'waits for you',
  unknown: 'is running',
  exited: 'exited',
};

export const MOMENT_LABELS: Record<AdvisorMoment, string> = {
  'before-plan': 'Before the plan',
  'repeated-error': 'Error again',
  'before-gate': 'Before a gate',
  'before-done': 'Before finishing',
};

/** Runs one event through the conductor. The input run is not modified. */
export function reduce(task: EnsembleTask, run: EnsembleRun, event: ConductorEvent, now: number): ReduceResult {
  const tx = new Tx(task, structuredClone(run), now);
  handle(tx, event);
  tx.pump();
  return {
    run: tx.run,
    effects: tx.effects,
    ...(tx.reply !== undefined ? { reply: tx.reply } : {}),
    ...(tx.error !== undefined ? { error: tx.error } : {}),
    ...(tx.questionId !== undefined ? { questionId: tx.questionId } : {}),
  };
}

function handle(tx: Tx, e: ConductorEvent): void {
  const run = tx.run;
  switch (e.type) {
    case 'start':
      if (run.status === 'preparing' || run.status === 'running' || run.status === 'paused') {
        tx.error = 'The task is already running.';
        return;
      }
      tx.start();
      return;
    case 'workspace-ready':
      if (run.status !== 'preparing') return;
      run.worktree = e.worktree;
      tx.setRunning();
      tx.log({
        type: 'run',
        text: `Workspace ready: ${e.worktree.path}${e.worktree.branch ? ` (${e.worktree.branch})` : ''}`,
      });
      tx.startStage(0);
      return;
    case 'workspace-failed':
      if (run.status !== 'preparing') return;
      run.status = 'failed';
      run.error = e.error;
      run.endedAt = tx.now;
      tx.log({ type: 'error', text: `The workspace could not be prepared: ${e.error}` });
      tx.notify('Ensemble task failed', e.error, 'error');
      return;
    case 'agent-started': {
      const s = run.agents[e.agentId];
      if (!s) return;
      s.lifecycle = 'running';
      s.terminalId = e.terminalId;
      if (e.cliSessionId) s.cliSessionId = e.cliSessionId;
      // Every terminal and session the agent used, for its cost (Usage Monitor) across restarts.
      s.usedTerminals = [...(s.usedTerminals ?? []).filter((t) => t !== e.terminalId), e.terminalId].slice(-20);
      if (e.cliSessionId)
        s.usedSessions = [...(s.usedSessions ?? []).filter((t) => t !== e.cliSessionId), e.cliSessionId].slice(-20);
      s.live = 'starting';
      s.liveSince = tx.now;
      tx.clearNeeds((n) => n.agentId === e.agentId && n.kind === 'exited');
      return;
    }
    case 'agent-start-failed': {
      const s = run.agents[e.agentId];
      if (!s) return;
      s.lifecycle = 'exited';
      s.error = e.error;
      tx.log({ type: 'error', text: `${tx.agentName(e.agentId)} could not start: ${e.error}`, agentId: e.agentId });
      tx.need('exited', `${tx.agentName(e.agentId)} could not start: ${e.error}`, { agentId: e.agentId });
      return;
    }
    case 'agent-state':
      tx.agentState(e.agentId, e.state);
      return;
    case 'delivered': {
      const s = run.agents[e.agentId];
      if (!s) return;
      if (s.assignment?.id === e.deliveryId) {
        s.assignment.deliveredAt = tx.now;
        delete s.assignment.delivering;
        delete s.assignment.idleSince;
        tx.log({
          type: 'delivered',
          text: `Delivered to ${tx.agentName(e.agentId)}`,
          agentId: e.agentId,
          stageId: s.assignment.stageId,
        });
        return;
      }
      const index = s.outbox.findIndex((o) => o.id === e.deliveryId);
      if (index >= 0) {
        const [item] = s.outbox.splice(index, 1);
        if (item && item.kind !== 'notice')
          tx.log({
            type: 'message',
            text: `→ ${tx.agentName(e.agentId)}: ${item.text.slice(0, 200)}`,
            agentId: e.agentId,
          });
        // A reminder starts a new wait for the submit.
        if (item?.kind === 'notice' && s.assignment) delete s.assignment.idleSince;
      }
      return;
    }
    case 'delivery-failed': {
      const s = run.agents[e.agentId];
      if (!s) return;
      tx.resetDelivery(s);
      tx.log({
        type: 'error',
        text: `Could not deliver to ${tx.agentName(e.agentId)}: ${e.error}`,
        agentId: e.agentId,
      });
      tx.need('delivery-failed', `${tx.agentName(e.agentId)} did not take the message: ${e.error}`, {
        agentId: e.agentId,
      });
      return;
    }
    case 'submit':
      tx.submit(e.agentId, e.submission, 'agent');
      return;
    case 'mark-done': {
      const a = run.agents[e.agentId]?.assignment;
      if (!a) {
        tx.error = `${tx.agentName(e.agentId)} has no open assignment.`;
        return;
      }
      tx.submit(
        e.agentId,
        {
          kind: a.output,
          summary: e.summary.trim() || 'Marked as done by the user',
          ...(a.output === 'review' ? { verdict: 'approve' as const, findings: [] } : {}),
          ...(a.output === 'advice' ? { target: 'user' } : {}),
        },
        'user',
      );
      return;
    }
    case 'progress': {
      const s = run.agents[e.agentId];
      if (!s) return;
      s.lastProgress = {
        message: e.message.slice(0, 200),
        at: tx.now,
        ...(e.percent !== undefined ? { percent: e.percent } : {}),
      };
      tx.log({ type: 'progress', text: `${tx.agentName(e.agentId)}: ${e.message.slice(0, 200)}`, agentId: e.agentId });
      return;
    }
    case 'command-started': {
      const st = run.stages.find((s) => s.stageId === e.stageId);
      if (st) st.terminalId = e.terminalId;
      return;
    }
    case 'command-finished':
      tx.commandFinished(e.stageId, e.exitCode, e.output);
      return;
    case 'checkpoint-done': {
      if (e.commit) {
        const stage = tx.stage(e.stageId);
        run.checkpoints.push({
          stageId: e.stageId,
          title: stage?.title ?? e.stageId,
          commit: e.commit,
          at: tx.now,
          ...(e.files !== undefined ? { files: e.files } : {}),
        });
        tx.log({
          type: 'checkpoint',
          text: `Checkpoint ${e.commit.slice(0, 7)} after "${stage?.title ?? e.stageId}"`,
          stageId: e.stageId,
        });
      }
      if (run.pendingCheckpoint !== e.stageId) return;
      delete run.pendingCheckpoint;
      const stage = tx.stage(e.stageId);
      if (stage && run.status === 'running') tx.advance(stage);
      return;
    }
    case 'gate':
      tx.gate(e.stageId, e.decision, e.comment, e.editedBody);
      return;
    case 'resolve-need':
      resolveNeed(tx, e.needId, e.action);
      return;
    case 'ask': {
      const from = tx.agent(e.from);
      if (!from) {
        tx.error = 'Unknown agent.';
        return;
      }
      const wanted = e.to.trim().toLowerCase();
      const to =
        wanted === 'user' || wanted === 'you'
          ? 'user'
          : tx.task.agents.find(
              (a) => a.id === wanted || a.name.toLowerCase() === wanted || a.role.label.toLowerCase() === wanted,
            )?.id;
      if (!to) {
        tx.error = `No agent "${e.to}" in the team. Ask one of: ${tx.task.agents.map((a) => a.name).join(', ')}, or "user".`;
        return;
      }
      if (to === e.from) {
        tx.error = 'You cannot ask yourself.';
        return;
      }
      const id = tx.nextId('q');
      run.questions.push({ id, from: e.from, to, question: e.question.slice(0, 8000), at: tx.now });
      tx.questionId = id;
      tx.log({
        type: 'question',
        text: `${from.name} → ${tx.agentName(to)}: ${e.question.slice(0, 200)}`,
        agentId: e.from,
      });
      if (to === 'user') {
        tx.need('question', `${from.name} asks: ${e.question.slice(0, 300)}`, { agentId: e.from, questionId: id });
        tx.notify(`${from.name} asks you`, e.question.slice(0, 200), 'warning');
      } else {
        tx.enqueue(
          to,
          'question',
          `${MESSAGE_PREFIX} Question from ${from.name} (${from.role.label}) — an agent, not the user (id ${id}): ${e.question} — Answer with oxy_ensemble_answer({"questionId": "${id}", "answer": "…"}).`,
        );
      }
      return;
    }
    case 'answer': {
      const q = run.questions.find((x) => x.id === e.questionId);
      if (!q) {
        tx.error = `No question ${e.questionId}.`;
        return;
      }
      if (q.answer !== undefined) {
        tx.error = 'This question was already answered.';
        return;
      }
      if (e.by !== 'user' && q.to !== e.by) {
        tx.error = 'This question is not addressed to you.';
        return;
      }
      q.answer = e.answer.slice(0, 8000);
      q.answeredBy = e.by;
      q.answeredAt = tx.now;
      tx.clearNeeds((n) => n.questionId === q.id);
      tx.log({
        type: 'answer',
        text: `${tx.agentName(e.by)} → ${tx.agentName(q.from)}: ${e.answer.slice(0, 200)}`,
        agentId: q.from,
        ...(e.by === 'user' ? { by: 'you' as const } : {}),
      });
      tx.effects.push({ type: 'question-answered', questionId: q.id, answer: q.answer });
      if (e.deliver && run.agents[q.from])
        tx.enqueue(
          q.from,
          'answer',
          `${MESSAGE_PREFIX} ${e.by === 'user' ? 'From the user' : `From ${tx.agentName(e.by)} (an agent, not the user)`} — answer to your question ${q.id}: ${q.answer}`,
        );
      tx.reply = 'Thanks — your answer was passed on.';
      return;
    }
    case 'note': {
      const text = e.text.trim().slice(0, 4000);
      if (!text) return;
      run.notes.push({ id: tx.nextId('note'), by: e.by, text, at: tx.now });
      tx.log({
        type: 'note',
        text: `${tx.agentName(e.by)}: ${text.slice(0, 200)}`,
        ...(e.by !== 'user' ? { agentId: e.by } : { by: 'you' as const }),
      });
      tx.reply = 'Noted on the board; every agent sees it in oxy_ensemble_context.';
      return;
    }
    case 'message': {
      const targets = e.to === 'all' ? tx.task.agents.map((a) => a.id) : [e.to];
      for (const id of targets) {
        if (!run.agents[id]) continue;
        tx.enqueue(id, 'message', `${MESSAGE_PREFIX} From the user: ${e.text}`);
      }
      tx.log({
        type: 'message',
        text: `You → ${e.to === 'all' ? 'everyone' : tx.agentName(e.to)}: ${e.text.slice(0, 200)}`,
        by: 'you',
      });
      return;
    }
    case 'context-served':
      tx.log({
        type: 'context',
        text: `${tx.agentName(e.agentId)} read its context`,
        agentId: e.agentId,
        items: e.items,
      });
      return;
    case 'take-over': {
      const s = run.agents[e.agentId];
      if (!s || s.takenOver) return;
      s.takenOver = true;
      tx.log({ type: 'state', text: `You took over ${tx.agentName(e.agentId)}`, agentId: e.agentId, by: 'you' });
      return;
    }
    case 'hand-back': {
      const s = run.agents[e.agentId];
      if (!s || !s.takenOver) return;
      s.takenOver = false;
      if (s.assignment?.idleSince !== undefined) s.assignment.idleSince = tx.now;
      tx.log({ type: 'state', text: `You handed ${tx.agentName(e.agentId)} back`, agentId: e.agentId, by: 'you' });
      return;
    }
    case 'restart-agent': {
      const s = run.agents[e.agentId];
      if (!s) return;
      if (s.lifecycle === 'running' || s.lifecycle === 'starting')
        tx.effects.push({ type: 'stop-agent', agentId: e.agentId });
      s.lifecycle = 'stopped';
      delete s.live;
      delete s.terminalId;
      delete s.readyAt;
      tx.resetDelivery(s);
      if (s.assignment) {
        delete s.assignment.deliveredAt;
        delete s.assignment.idleSince;
      }
      tx.clearNeeds((n) => n.agentId === e.agentId && n.kind !== 'question');
      tx.log({ type: 'state', text: `Restarting ${tx.agentName(e.agentId)}`, agentId: e.agentId, by: 'you' });
      if (!s.assignment && !s.outbox.length) s.lifecycle = 'not-started';
      return;
    }
    case 'advisor-enabled':
      run.advisorEnabled = e.enabled;
      tx.log({ type: 'advice', text: `Advisor ${e.enabled ? 'on call' : 'switched off'}`, by: 'you' });
      if (!e.enabled)
        for (const a of run.advice)
          if (a.status === 'asked') {
            a.status = 'failed';
            const id = tx.task.advisor?.agentId;
            if (id && run.agents[id]?.assignment?.kind === 'advice') delete run.agents[id].assignment;
            tx.releaseAdvice(a, undefined);
          }
      return;
    case 'cost': {
      const s = run.agents[e.agentId];
      if (!s) return;
      if (e.costUsd !== undefined) s.costUsd = e.costUsd;
      if (e.tokens !== undefined) s.tokens = e.tokens;
      run.costUsd = Object.values(run.agents).reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
      return;
    }
    case 'pause':
      if (run.status !== 'running') return;
      tx.setNotRunning();
      run.status = 'paused';
      run.pauseReason = 'Paused by you';
      tx.log({ type: 'run', text: 'Paused', by: 'you' });
      return;
    case 'resume':
      if (run.status !== 'paused') return;
      tx.clearNeeds((n) => n.kind === 'limit');
      if (run.pauseReason && run.pauseReason !== 'Paused by you') run.limitOverride = true;
      tx.setRunning();
      tx.log({ type: 'run', text: 'Resumed', by: 'you' });
      return;
    case 'stop':
      if (
        run.status !== 'running' &&
        run.status !== 'paused' &&
        run.status !== 'preparing' &&
        run.status !== 'interrupted'
      )
        return;
      tx.stopRun('by you');
      return;
    case 'interrupted':
      if (run.status !== 'running' && run.status !== 'paused' && run.status !== 'preparing') return;
      tx.setNotRunning();
      run.status = run.status === 'preparing' ? 'failed' : 'interrupted';
      if (run.status === 'failed') run.error = 'Oxytocin was closed while the workspace was prepared.';
      for (const s of Object.values(run.agents)) {
        if (s.lifecycle !== 'not-started') s.lifecycle = 'stopped';
        delete s.live;
        delete s.terminalId;
        delete s.readyAt;
        s.takenOver = false;
        tx.resetDelivery(s);
        if (s.assignment) {
          delete s.assignment.deliveredAt;
          delete s.assignment.idleSince;
        }
      }
      run.needs = run.needs.filter(
        (n) =>
          n.kind === 'gate' ||
          n.kind === 'question' ||
          n.kind === 'loop-limit' ||
          n.kind === 'command-failed' ||
          n.kind === 'finish',
      );
      tx.log({ type: 'run', text: 'Interrupted: Oxytocin was closed while the task ran' });
      return;
    case 'resume-interrupted': {
      if (run.status !== 'interrupted') return;
      tx.setRunning();
      tx.log({ type: 'run', text: 'Resumed after a restart', by: 'you' });
      const stage = tx.currentStage();
      const st = stage ? run.stages.find((s) => s.stageId === stage.id) : undefined;
      if (stage?.kind === 'command' && st?.status === 'running' && st.phase === 'run')
        tx.effects.push({ type: 'run-command', stageId: stage.id, command: stage.command, attempt: st.attempts ?? 1 });
      if (run.pendingCheckpoint) {
        const pending = tx.stage(run.pendingCheckpoint);
        if (pending)
          tx.effects.push({ type: 'checkpoint', stageId: pending.id, message: `ensemble: ${pending.title}` });
      }
      if (!stage && run.stageIndex >= tx.task.pipeline.length) tx.finishRun();
      return;
    }
    case 'finished':
      run.finished = { action: e.action, at: tx.now, ...(e.detail ? { detail: e.detail } : {}) };
      tx.clearNeeds((n) => n.kind === 'finish');
      tx.log({ type: 'run', text: `Finished: ${FINISH_TEXT[e.action]}${e.detail ? ` — ${e.detail}` : ''}`, by: 'you' });
      return;
    case 'tick':
      tx.tick();
      return;
  }
}

const FINISH_TEXT: Record<FinishAction, string> = {
  merge: 'merged into the base branch',
  squash: 'squashed into one commit on the base branch',
  keep: 'branch kept',
  discard: 'branch discarded',
};

function resolveNeed(tx: Tx, needId: string, action: string): void {
  const run = tx.run;
  const need = run.needs.find((n) => n.id === needId);
  if (!need) {
    tx.error = 'This item is no longer waiting.';
    return;
  }
  const stage = need.stageId ? tx.stage(need.stageId) : undefined;
  const st = stage ? tx.stageState(stage.id) : undefined;
  const drop = () => tx.clearNeeds((n) => n.id === needId);
  switch (need.kind) {
    case 'loop-limit':
      if (!stage || stage.kind !== 'loop' || !st) return drop();
      drop();
      if (action === 'accept') {
        tx.decide('round limit', 'you accepted the result', '→ stage done', { stageId: stage.id }, 'you');
        tx.completeStage(stage, `accepted after ${st.round ?? 1} rounds`);
      } else if (action === 'more') {
        st.extraRounds = tx.extraRounds(st) + 1;
        const round = (st.round ?? 1) + 1;
        st.round = round;
        st.phase = 'work';
        const review = latestHandoff(run, 'review', stage.checkerId);
        tx.decide(
          'round limit',
          'you asked for one more round',
          `→ back to ${tx.agentName(stage.workerId)}`,
          { stageId: stage.id },
          'you',
        );
        tx.assign(stage.workerId, stage, 'implementation', 'fix', {
          round,
          maxRounds: stage.maxRounds + tx.extraRounds(st),
          extra: `The review asks for changes:\n\n${formatFindings(review?.findings)}\n\nFix them, then submit with kind "implementation" again.`,
        });
      } else tx.stopRun(`after the round limit of "${stage.title}"`);
      return;
    case 'command-failed':
      if (!stage || stage.kind !== 'command' || !st) return drop();
      drop();
      if (action === 'retry') {
        st.attempts = (st.attempts ?? 1) + 1;
        st.phase = 'run';
        tx.decide('command failed', 'you chose retry', `→ run ${stage.command} again`, { stageId: stage.id }, 'you');
        tx.effects.push({ type: 'run-command', stageId: stage.id, command: stage.command, attempt: st.attempts });
      } else if (action === 'skip') {
        tx.decide('command failed', 'you chose to continue', '→ next stage', { stageId: stage.id }, 'you');
        tx.completeStage(stage, `failed, continued by you`);
      } else tx.stopRun(`after ${stage.command} failed`);
      return;
    case 'limit':
      drop();
      if (action === 'continue' && run.status === 'paused') {
        run.limitOverride = true;
        tx.setRunning();
        tx.log({ type: 'run', text: 'Continued past the limit', by: 'you' });
      } else if (action === 'stop') tx.stopRun('at a limit');
      return;
    case 'stuck':
      if (action === 'remind' && need.agentId) {
        const a = run.agents[need.agentId]?.assignment;
        const agent = tx.agent(need.agentId);
        if (a && agent) tx.enqueue(need.agentId, 'notice', reminderMessage(agent, a.output));
      }
      drop();
      return;
    case 'exited':
      drop();
      if (action === 'restart' && need.agentId) handle(tx, { type: 'restart-agent', agentId: need.agentId });
      return;
    case 'finish':
    case 'gate':
    case 'question':
      // Settled by their own actions (the finish dialog, a gate decision, an answer); dismissing only hides them.
      if (action === 'dismiss') drop();
      return;
    default:
      drop();
      return;
  }
}

// ── validation ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TaskProblem {
  /** `task`, `agent:<id>`, `stage:<id>`. */
  where: string;
  message: string;
}

/** Whether a task can start; problems are shown inline in the builder. */
export function validateTask(task: EnsembleTask): TaskProblem[] {
  const problems: TaskProblem[] = [];
  const agents = new Map(task.agents.map((a) => [a.id, a]));
  if (!task.title.trim()) problems.push({ where: 'task', message: 'Give the task a title.' });
  if (task.agents.length === 0) problems.push({ where: 'task', message: 'Add at least one agent to the team.' });
  if (task.pipeline.length === 0) problems.push({ where: 'task', message: 'Add at least one stage to the pipeline.' });
  const ids = new Set<string>();
  for (const a of task.agents) {
    if (ids.has(a.id)) problems.push({ where: `agent:${a.id}`, message: `Two agents have the id "${a.id}".` });
    ids.add(a.id);
    if (a.cli === 'custom' && !a.customCommand?.trim())
      problems.push({ where: `agent:${a.id}`, message: `${a.name}: a custom CLI needs a command.` });
  }
  const names = new Set<string>();
  for (const a of task.agents) {
    const key = a.name.toLowerCase();
    if (names.has(key)) problems.push({ where: `agent:${a.id}`, message: `Two agents are called ${a.name}.` });
    names.add(key);
  }
  const stageIds = new Set<string>();
  const advisorId = task.advisor?.agentId;
  const known = (id: string, stage: Stage, role: string) => {
    if (!agents.has(id))
      problems.push({ where: `stage:${stage.id}`, message: `"${stage.title}": choose the ${role}.` });
    else if (id === advisorId)
      problems.push({ where: `stage:${stage.id}`, message: `"${stage.title}": the advisor does not work on stages.` });
  };
  for (const stage of task.pipeline) {
    if (stageIds.has(stage.id))
      problems.push({ where: `stage:${stage.id}`, message: `Two stages have the id "${stage.id}".` });
    stageIds.add(stage.id);
    switch (stage.kind) {
      case 'agent':
        known(stage.agentId, stage, 'agent');
        break;
      case 'parallel': {
        for (const id of stage.agentIds) known(id, stage, 'agents');
        if (new Set(stage.agentIds).size !== stage.agentIds.length)
          problems.push({ where: `stage:${stage.id}`, message: `"${stage.title}": an agent appears twice.` });
        const writers = stage.agentIds.filter((id) => agents.get(id) && !agents.get(id)!.readOnly);
        if (writers.length > 0)
          problems.push({
            where: `stage:${stage.id}`,
            message: `"${stage.title}": parallel agents share one working folder, so they must be read-only (${writers.map((id) => agents.get(id)!.name).join(', ')}).`,
          });
        break;
      }
      case 'loop':
        known(stage.workerId, stage, 'worker');
        known(stage.checkerId, stage, 'reviewer');
        if (stage.workerId === stage.checkerId)
          problems.push({ where: `stage:${stage.id}`, message: `"${stage.title}": the worker cannot review itself.` });
        break;
      case 'command':
        if (stage.onFail.agentId) known(stage.onFail.agentId, stage, 'agent that fixes failures');
        break;
      case 'gate':
        break;
    }
  }
  if (task.pipeline[0]?.kind === 'gate')
    problems.push({
      where: `stage:${task.pipeline[0].id}`,
      message: 'The pipeline cannot start with an approval gate.',
    });
  if (task.advisor) {
    const advisor = agents.get(task.advisor.agentId);
    if (!advisor) problems.push({ where: 'task', message: 'The advisor is not in the team.' });
    else if (!advisor.readOnly)
      problems.push({ where: `agent:${advisor.id}`, message: `${advisor.name} is the advisor and must be read-only.` });
  }
  return problems;
}

/** Agents that take part in the pipeline (or advise it). */
export function usedAgentIds(task: EnsembleTask): Set<string> {
  const used = new Set<string>();
  for (const stage of task.pipeline) for (const id of stageAgents(stage)) used.add(id);
  if (task.advisor) used.add(task.advisor.agentId);
  return used;
}
