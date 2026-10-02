import { describe, expect, it } from 'vitest';
import type { EnsembleRun, EnsembleTask, Stage, Submission } from '../domain/ensemble';
import { EnsembleRecordSchema } from '../domain/ensemble';
import {
  type ConductorEvent,
  type Effect,
  initialRun,
  READY_TIMEOUT_MS,
  reduce,
  REMINDER_AFTER_MS,
  validateTask,
} from './conductor';
import { agentFromPreset, taskFromTemplate } from './presets';
import { isSafeToType } from './prompts';

function makeTask(pipeline: Stage[], extra: Partial<EnsembleTask> = {}): EnsembleTask {
  const planner = agentFromPreset('planner', []);
  const implementer = agentFromPreset('implementer', [planner]);
  const reviewer = agentFromPreset('reviewer', [planner, implementer]);
  return {
    v: 1,
    id: 'task-1',
    projectId: 'p1',
    title: 'CSV export',
    description: 'Add CSV export to the reports page.',
    generalPrompt: 'Use TypeScript.',
    attachments: [],
    workspace: { mode: 'worktree', setupCommands: [], copyFiles: [] },
    agents: [planner, implementer, reviewer],
    pipeline,
    limits: { maxConcurrentAgents: 3 },
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

/** Drives the conductor like the service does; records every effect. */
class Harness {
  run: EnsembleRun;
  now = 1000;
  effects: Effect[] = [];
  terminals = 0;

  constructor(readonly task: EnsembleTask) {
    this.run = initialRun(task);
  }

  send(event: ConductorEvent) {
    const r = reduce(this.task, this.run, event, this.now);
    this.run = r.run;
    this.effects.push(...r.effects);
    return r;
  }

  take(type: Effect['type']): Effect[] {
    const found = this.effects.filter((e) => e.type === type);
    this.effects = this.effects.filter((e) => e.type !== type);
    return found;
  }

  start(worktree = true) {
    this.send({ type: 'start' });
    expect(this.take('prepare-workspace')).toHaveLength(1);
    this.send({
      type: 'workspace-ready',
      worktree: worktree
        ? { mode: 'worktree', path: '/wt', branch: 'ensemble/csv', baseRef: 'main', baseCommit: 'abc1234' }
        : { mode: 'current-checkout', path: '/repo' },
    });
  }

  /** Starts requested agents and makes them idle (ready). */
  boot() {
    for (const e of this.take('start-agent')) {
      if (e.type !== 'start-agent') continue;
      this.send({
        type: 'agent-started',
        agentId: e.agentId,
        terminalId: `t${++this.terminals}`,
        cliSessionId: `s-${e.agentId}`,
      });
      this.send({ type: 'agent-state', agentId: e.agentId, state: 'idle' });
    }
  }

  /** Confirms every pending delivery (the agent starts working). */
  deliverAll(): Extract<Effect, { type: 'deliver' }>[] {
    const delivered = this.take('deliver') as Extract<Effect, { type: 'deliver' }>[];
    for (const d of delivered) {
      this.send({ type: 'agent-state', agentId: d.agentId, state: 'working' });
      this.send({ type: 'delivered', agentId: d.agentId, deliveryId: d.deliveryId });
    }
    return delivered;
  }

  submit(agentId: string, submission: Submission) {
    const r = this.send({ type: 'submit', agentId, submission });
    this.send({ type: 'agent-state', agentId, state: 'idle' });
    return r;
  }

  checkpoints() {
    for (const e of this.take('checkpoint'))
      if (e.type === 'checkpoint') this.send({ type: 'checkpoint-done', stageId: e.stageId, commit: `c-${e.stageId}` });
  }
}

const planStage: Stage = {
  id: 'plan',
  kind: 'agent',
  title: 'Plan',
  instruction: '',
  agentId: 'ada',
  output: 'plan',
  freshSession: false,
};
const implStage: Stage = {
  id: 'impl',
  kind: 'agent',
  title: 'Implement',
  instruction: 'Implement following:\n{{plan}}',
  agentId: 'linus',
  output: 'implementation',
  freshSession: false,
};

describe('conductor: sequential agent stages', () => {
  it('runs two stages in order and hands the plan to the implementer', () => {
    const h = new Harness(makeTask([planStage, implStage]));
    h.start();
    expect(h.run.status).toBe('running');
    expect(h.take('start-agent')).toEqual([{ type: 'start-agent', agentId: 'ada', resume: false }]);
    h.send({ type: 'agent-started', agentId: 'ada', terminalId: 't1' });
    // Not idle yet: nothing is typed.
    expect(h.take('deliver')).toEqual([]);
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    const [delivery] = h.deliverAll();
    expect(delivery?.text).toMatch(/^\[Ensemble\] New assignment for Ada \(Planner\) — stage "Plan"/);
    expect(isSafeToType(delivery!.text)).toBe(true);

    const r = h.submit('ada', { kind: 'plan', summary: 'Plan ready', body: '1. Add exporter\n2. Add button' });
    expect(r.error).toBeUndefined();
    // Planner is read-only: no checkpoint; the implementer starts.
    expect(h.take('checkpoint')).toEqual([]);
    expect(h.run.stageIndex).toBe(1);
    h.boot();
    h.deliverAll();
    expect(h.run.agents['linus']!.assignment!.instruction).toContain('1. Add exporter');
    h.submit('linus', { kind: 'implementation', summary: 'Done', files: ['src/csv.ts'] });
    // The implementer writes: a checkpoint is committed before the run ends.
    expect(h.run.pendingCheckpoint).toBe('impl');
    expect(h.run.status).toBe('running');
    h.checkpoints();
    expect(h.run.status).toBe('done');
    expect(h.run.checkpoints.map((c) => c.commit)).toEqual(['c-impl']);
    expect(h.take('stop-all')).toHaveLength(1);
    expect(h.run.needs.map((n) => n.kind)).toEqual(['finish']);
    expect(h.run.stages.map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('types the whole context with an assignment: instruction, brief and earlier results, no tool call needed', () => {
    const h = new Harness(makeTask([planStage, implStage]));
    h.start();
    h.boot();
    const [plan] = h.deliverAll();
    expect(plan!.text).toContain('## Your assignment — stage "Plan"');
    expect(plan!.text).toContain('## The brief\n\nAdd CSV export to the reports page.');
    expect(plan!.text).toContain('Use TypeScript.');
    expect(plan!.text).toContain('call oxy_ensemble_submit with kind "plan"');
    expect(h.run.events.some((e) => e.type === 'context' && e.agentId === 'ada')).toBe(true);
    h.submit('ada', { kind: 'plan', summary: 'Plan ready', body: '1. Add exporter' });
    h.boot();
    const [impl] = h.deliverAll();
    expect(impl!.text).toMatch(/### The plan \(by Ada\)\s+1\. Add exporter/);
  });

  it('gives CLIs without a system prompt file the protocol and the brief once per session', () => {
    const task = makeTask([planStage]);
    task.agents[0] = { ...task.agents[0]!, cli: 'codex' };
    const h = new Harness(task);
    h.start();
    h.boot();
    const [first] = h.deliverAll();
    expect(first!.text).toContain('# Ensemble — you are Ada');
    expect(h.run.agents['ada']!.introduced).toBe(true);
    // A new session (restart) is introduced again.
    h.send({ type: 'agent-started', agentId: 'ada', terminalId: 't7', cliSessionId: 'other' });
    expect(h.run.agents['ada']!.introduced).toBeUndefined();
  });

  it('rejects a submission of the wrong kind and a submission without an assignment', () => {
    const h = new Harness(makeTask([planStage]));
    h.start();
    h.boot();
    h.deliverAll();
    expect(h.send({ type: 'submit', agentId: 'ada', submission: { kind: 'review', summary: 'x' } }).error).toMatch(
      /expects kind "plan"/,
    );
    expect(h.send({ type: 'submit', agentId: 'linus', submission: { kind: 'plan', summary: 'x' } }).error).toMatch(
      /no open assignment/,
    );
  });

  it('never delivers while the agent is working or waiting, and never while taken over', () => {
    const h = new Harness(makeTask([planStage]));
    h.start();
    h.take('start-agent');
    h.send({ type: 'agent-started', agentId: 'ada', terminalId: 't1' });
    h.send({ type: 'agent-state', agentId: 'ada', state: 'waiting' });
    expect(h.take('deliver')).toEqual([]);
    expect(h.run.needs.map((n) => n.kind)).toEqual(['permission']);
    h.send({ type: 'take-over', agentId: 'ada' });
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    expect(h.take('deliver')).toEqual([]);
    expect(h.run.needs).toEqual([]);
    h.send({ type: 'hand-back', agentId: 'ada' });
    expect(h.take('deliver')).toHaveLength(1);
  });

  it('reminds an agent that stopped without submitting, then needs the user; mark as done continues', () => {
    const h = new Harness(makeTask([planStage, implStage]));
    h.start();
    h.boot();
    h.deliverAll();
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    h.now += REMINDER_AFTER_MS + 1;
    h.send({ type: 'tick' });
    const [reminder] = h.take('deliver');
    expect(reminder).toMatchObject({ agentId: 'ada' });
    expect((reminder as { text: string }).text).toMatch(/stopped without calling oxy_ensemble_submit/);
    h.send({ type: 'agent-state', agentId: 'ada', state: 'working' });
    h.send({ type: 'delivered', agentId: 'ada', deliveryId: (reminder as { deliveryId: string }).deliveryId });
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    h.now += REMINDER_AFTER_MS + 1;
    h.send({ type: 'tick' });
    expect(h.take('deliver')).toEqual([]);
    expect(h.run.needs.map((n) => n.kind)).toEqual(['stuck']);
    h.send({ type: 'mark-done', agentId: 'ada', summary: 'The plan is in PLAN.md' });
    expect(h.run.needs).toEqual([]);
    expect(h.run.handoffs.at(-1)).toMatchObject({ by: 'user', kind: 'plan', summary: 'The plan is in PLAN.md' });
    expect(h.run.stageIndex).toBe(1);
  });

  it('pause holds deliveries, resume releases them; stop kills every agent', () => {
    const h = new Harness(makeTask([planStage]));
    h.start();
    h.send({ type: 'pause' });
    h.boot();
    expect(h.take('deliver')).toEqual([]);
    h.send({ type: 'resume' });
    expect(h.take('deliver')).toHaveLength(1);
    h.send({ type: 'stop' });
    expect(h.run.status).toBe('stopped');
    expect(h.take('stop-all')).toHaveLength(1);
    expect(h.run.needs.map((n) => n.kind)).toEqual(['finish']);
  });

  it('asks the user when an agent does not become ready', () => {
    const h = new Harness(makeTask([planStage]));
    h.start();
    h.take('start-agent');
    h.send({ type: 'agent-started', agentId: 'ada', terminalId: 't1' });
    h.now += READY_TIMEOUT_MS + 1;
    h.send({ type: 'tick' });
    expect(h.run.needs.map((n) => n.kind)).toEqual(['not-ready']);
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    expect(h.run.needs).toEqual([]);
  });

  it('an app restart interrupts the run; resume restarts the agents with their sessions and delivers again', () => {
    const h = new Harness(makeTask([planStage]));
    h.start();
    h.boot();
    h.deliverAll();
    h.send({ type: 'interrupted' });
    expect(h.run.status).toBe('interrupted');
    expect(h.run.agents['ada']!.lifecycle).toBe('stopped');
    h.send({ type: 'resume-interrupted' });
    expect(h.take('start-agent')).toEqual([{ type: 'start-agent', agentId: 'ada', resume: true }]);
    h.send({ type: 'agent-started', agentId: 'ada', terminalId: 't9' });
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    expect(h.take('deliver')).toHaveLength(1);
  });
});

describe('conductor: delegation', () => {
  const withApi = () => {
    const task = makeTask([planStage, implStage]);
    task.agents.push(agentFromPreset('api-researcher', task.agents));
    return task;
  };

  it('the planner delegates to the API researcher, gets the report back and is not reminded while waiting', () => {
    const h = new Harness(withApi());
    h.start();
    h.boot();
    h.deliverAll();
    const r = h.send({ type: 'delegate', from: 'ada', to: 'API researcher', work: 'Map GET /users and its shape.' });
    expect(r.error).toBeUndefined();
    expect(r.reply).toMatch(/Delegated to Tim/);
    const tim = h.run.agents['tim']!;
    expect(tim.assignment).toMatchObject({
      kind: 'delegated',
      delegatedBy: 'ada',
      output: 'research',
      stageId: 'plan',
    });
    // Tim starts and gets the work with the brief.
    h.boot();
    const [work] = h.deliverAll();
    expect(work!.text).toMatch(/^\[Ensemble\] Ada \(Planner\) delegated work to you, Tim \(API researcher\)/);
    expect(work!.text).toContain('Map GET /users and its shape.');
    expect(work!.text).toContain('## The brief');
    // Ada is idle and waits: no reminder.
    h.send({ type: 'agent-state', agentId: 'ada', state: 'idle' });
    h.now += REMINDER_AFTER_MS + 1000;
    h.send({ type: 'tick' });
    expect(h.run.agents['ada']!.outbox).toEqual([]);
    // The report reaches Ada with its line breaks; the stage is still Ada's.
    const sub = h.submit('tim', {
      kind: 'research',
      summary: 'GET /users is paged',
      body: '```ts\ntype User = { id: number }\n```',
    });
    expect(sub.reply).toMatch(/goes to Ada/);
    expect(h.run.stageIndex).toBe(0);
    const [report] = h.deliverAll();
    expect(report!.text).toMatch(/^\[Ensemble\] Report from Tim/);
    expect(report!.text).toContain('```ts\ntype User = { id: number }\n```');
    expect(h.run.handoffs.at(-1)).toMatchObject({ agentId: 'tim', kind: 'research', stageId: 'plan' });
    // Ada submits the plan: the next stage gets Tim's report too.
    h.submit('ada', { kind: 'plan', summary: 'Plan', body: '1. Use GET /users' });
    h.boot();
    const [impl] = h.deliverAll();
    expect(impl!.text).toContain('Tim — Research');
  });

  it('refuses unknown, busy or self delegation and delegation of delegated work', () => {
    const h = new Harness(withApi());
    h.start();
    h.boot();
    h.deliverAll();
    expect(h.send({ type: 'delegate', from: 'ada', to: 'nobody', work: 'x' }).error).toMatch(/No agent "nobody"/);
    expect(h.send({ type: 'delegate', from: 'ada', to: 'Ada', work: 'x' }).error).toMatch(/yourself/);
    expect(h.send({ type: 'delegate', from: 'linus', to: 'tim', work: 'x' }).error).toMatch(/Only an agent working/);
    h.send({ type: 'delegate', from: 'ada', to: 'tim', work: 'x' });
    expect(h.send({ type: 'delegate', from: 'ada', to: 'tim', work: 'y' }).error).toMatch(/Tim is busy/);
    expect(h.send({ type: 'delegate', from: 'tim', to: 'grace', work: 'z' }).error).toMatch(/Only an agent working/);
  });

  it('open delegated work ends with the stage', () => {
    const h = new Harness(withApi());
    h.start();
    h.boot();
    h.deliverAll();
    h.send({ type: 'delegate', from: 'ada', to: 'tim', work: 'x' });
    h.submit('ada', { kind: 'plan', summary: 'Plan without waiting' });
    expect(h.run.agents['tim']!.assignment).toBeUndefined();
  });
});

describe('conductor: costs and the budget', () => {
  it('remembers every terminal and session of an agent, sums costs and pauses at the budget', () => {
    const h = new Harness(makeTask([planStage], { limits: { maxConcurrentAgents: 3, maxCostUsd: 1 } }));
    h.start();
    h.boot();
    h.deliverAll();
    h.send({ type: 'interrupted' });
    h.send({ type: 'resume-interrupted' });
    h.take('start-agent');
    h.send({ type: 'agent-started', agentId: 'ada', terminalId: 't9', cliSessionId: 's-ada' });
    expect(h.run.agents['ada']).toMatchObject({ usedTerminals: ['t1', 't9'], usedSessions: ['s-ada'] });
    h.send({ type: 'cost', agentId: 'ada', costUsd: 0.4, tokens: 1000 });
    h.send({ type: 'tick' });
    expect(h.run.costUsd).toBeCloseTo(0.4, 6);
    expect(h.run.status).toBe('running');
    h.send({ type: 'cost', agentId: 'ada', costUsd: 1.2, tokens: 3000 });
    h.send({ type: 'tick' });
    expect(h.run.status).toBe('paused');
    expect(h.run.pauseReason).toMatch(/budget of \$1 is reached/);
  });
});

describe('conductor: loops, gates and commands', () => {
  const loop: Stage = {
    id: 'loop',
    kind: 'loop',
    title: 'Implement ⇄ Review',
    instruction: '',
    workerId: 'linus',
    checkerId: 'grace',
    maxRounds: 3,
    checkerInstruction: '',
  };

  it('a review loop needs two rounds; findings go back to the same worker session', () => {
    const h = new Harness(makeTask([loop]));
    h.start();
    h.boot();
    h.deliverAll();
    h.submit('linus', { kind: 'implementation', summary: 'v1' });
    h.boot();
    h.deliverAll();
    expect(h.run.agents['grace']!.assignment?.output).toBe('review');
    expect(
      h.send({ type: 'submit', agentId: 'grace', submission: { kind: 'review', summary: 'bad', verdict: 'changes' } })
        .error,
    ).toMatch(/needs `findings`/);
    const r = h.submit('grace', {
      kind: 'review',
      summary: 'Two problems',
      verdict: 'changes',
      findings: [{ file: 'src/csv.ts', line: 3, severity: 'major', message: 'Quote commas' }],
    });
    expect(r.reply).toMatch(/Linus gets your 1 finding/);
    expect(h.take('start-agent')).toEqual([]);
    const [fix] = h.deliverAll();
    expect(fix).toMatchObject({ agentId: 'linus' });
    expect(fix!.text).toMatch(/Changes requested .* \(round 2\/3\)/);
    expect(h.run.agents['linus']!.assignment!.instruction).toContain('src/csv.ts:3 — Quote commas');
    h.submit('linus', { kind: 'implementation', summary: 'v2' });
    h.deliverAll();
    h.submit('grace', { kind: 'review', summary: 'Good', verdict: 'approve', findings: [] });
    expect(h.run.stages[0]).toMatchObject({ status: 'done', outcome: 'approved in round 2', round: 2 });
    h.checkpoints();
    expect(h.run.status).toBe('done');
  });

  it('the round limit needs the user: one more round or accept', () => {
    const h = new Harness(makeTask([{ ...loop, maxRounds: 1 }]));
    h.start();
    h.boot();
    h.deliverAll();
    h.submit('linus', { kind: 'implementation', summary: 'v1' });
    h.boot();
    h.deliverAll();
    h.submit('grace', {
      kind: 'review',
      summary: 'no',
      verdict: 'changes',
      findings: [{ severity: 'major', message: 'x' }],
    });
    const need = h.run.needs.find((n) => n.kind === 'loop-limit')!;
    expect(need).toBeDefined();
    h.send({ type: 'resolve-need', needId: need.id, action: 'more' });
    h.deliverAll();
    h.submit('linus', { kind: 'implementation', summary: 'v2' });
    h.deliverAll();
    h.submit('grace', {
      kind: 'review',
      summary: 'still',
      verdict: 'changes',
      findings: [{ severity: 'minor', message: 'y' }],
    });
    const again = h.run.needs.find((n) => n.kind === 'loop-limit')!;
    h.send({ type: 'resolve-need', needId: again.id, action: 'accept' });
    expect(h.run.stages[0]!.status).toBe('done');
  });

  it('a gate waits for the user; a rejection sends the comment back to the previous stage', () => {
    const gate: Stage = {
      id: 'gate',
      kind: 'gate',
      title: 'Approve the plan',
      instruction: '',
      show: ['plan'],
      onReject: 'back-to-previous',
    };
    const h = new Harness(makeTask([planStage, gate, implStage]));
    h.start();
    h.boot();
    h.deliverAll();
    h.submit('ada', { kind: 'plan', summary: 'Plan v1' });
    expect(h.run.stages[1]!.status).toBe('waiting-gate');
    expect(h.run.needs.map((n) => n.kind)).toEqual(['gate']);
    expect(h.take('notify')).toHaveLength(1);
    h.send({ type: 'gate', stageId: 'gate', decision: 'reject', comment: 'Also support TSV' });
    expect(h.run.stageIndex).toBe(0);
    const [revision] = h.deliverAll();
    expect(revision!.text).toMatch(/Changes requested for Ada/);
    expect(h.run.agents['ada']!.assignment!.instruction).toContain('Also support TSV');
    h.submit('ada', { kind: 'plan', summary: 'Plan v2' });
    h.send({ type: 'gate', stageId: 'gate', decision: 'approve', editedBody: 'Plan v2, edited' });
    expect(h.run.stageIndex).toBe(2);
    h.boot();
    h.deliverAll();
    expect(h.run.agents['linus']!.assignment!.instruction).toContain('Plan v2, edited');
    const decisions = h.run.events.filter((e) => e.type === 'decision' && e.by === 'you');
    expect(decisions.map((d) => d.outcome)).toEqual(['→ back to "Plan" (Ada)', '→ next stage']);
  });

  it('a failing command goes to the fixer, then runs again and passes', () => {
    const tests: Stage = {
      id: 'tests',
      kind: 'command',
      title: 'Tests',
      instruction: '',
      command: 'npm test',
      onFail: { agentId: 'linus', maxAttempts: 2 },
    };
    const h = new Harness(makeTask([tests]));
    h.start();
    expect(h.take('run-command')).toEqual([{ type: 'run-command', stageId: 'tests', command: 'npm test', attempt: 1 }]);
    h.send({ type: 'command-finished', stageId: 'tests', exitCode: 1, output: 'FAIL csv.test.ts' });
    h.boot();
    const [fix] = h.deliverAll();
    expect(fix).toMatchObject({ agentId: 'linus' });
    expect(h.run.agents['linus']!.assignment!.instruction).toContain('FAIL csv.test.ts');
    const r = h.submit('linus', { kind: 'implementation', summary: 'Fixed the quoting' });
    expect(r.reply).toMatch(/runs `npm test` again/);
    expect(h.take('run-command')).toEqual([{ type: 'run-command', stageId: 'tests', command: 'npm test', attempt: 2 }]);
    h.send({ type: 'command-finished', stageId: 'tests', exitCode: 0, output: 'ok' });
    expect(h.run.stages[0]).toMatchObject({ status: 'done', outcome: 'passed after 2 attempts' });
  });

  it('a command without attempts left needs the user (retry, continue, stop)', () => {
    const tests: Stage = {
      id: 'tests',
      kind: 'command',
      title: 'Tests',
      instruction: '',
      command: 'npm test',
      onFail: { maxAttempts: 0 },
    };
    const h = new Harness(makeTask([tests]));
    h.start();
    h.send({ type: 'command-finished', stageId: 'tests', exitCode: 2, output: 'boom' });
    const need = h.run.needs.find((n) => n.kind === 'command-failed')!;
    h.take('run-command');
    h.send({ type: 'resolve-need', needId: need.id, action: 'retry' });
    expect(h.take('run-command')).toHaveLength(1);
    h.send({ type: 'command-finished', stageId: 'tests', exitCode: 2, output: 'boom' });
    const again = h.run.needs.find((n) => n.kind === 'command-failed')!;
    h.send({ type: 'resolve-need', needId: again.id, action: 'skip' });
    expect(h.run.stages[0]!.status).toBe('done');
  });
});

describe('conductor: parallel stages, questions and the advisor', () => {
  it('a parallel stage starts read-only agents up to the concurrency limit and joins all', () => {
    const task = makeTask([]);
    const r2 = { ...agentFromPreset('reviewer', task.agents), readOnly: true };
    task.agents.push(r2);
    task.limits.maxConcurrentAgents = 1;
    task.pipeline = [
      {
        id: 'rev',
        kind: 'parallel',
        title: 'Review',
        instruction: '',
        agentIds: ['grace', r2.id],
        output: 'review',
        join: 'all',
      },
    ];
    const h = new Harness(task);
    h.start();
    expect(h.take('start-agent').map((e) => (e as { agentId: string }).agentId)).toEqual(['grace']);
    h.send({ type: 'agent-started', agentId: 'grace', terminalId: 't1' });
    h.send({ type: 'agent-state', agentId: 'grace', state: 'idle' });
    h.deliverAll();
    const r = h.submit('grace', { kind: 'review', summary: 'ok', verdict: 'approve', findings: [] });
    expect(r.reply).toMatch(/Waiting for Grace 2/);
    h.boot();
    h.deliverAll();
    h.submit(r2.id, { kind: 'review', summary: 'ok too', verdict: 'approve', findings: [] });
    expect(h.run.status).toBe('done');
  });

  it('routes a question to another agent and the answer back to the asker', () => {
    const h = new Harness(makeTask([planStage, implStage]));
    h.start();
    h.boot();
    h.deliverAll();
    h.submit('ada', { kind: 'plan', summary: 'Plan' });
    h.boot();
    h.deliverAll();
    const asked = h.send({ type: 'ask', from: 'linus', to: 'Ada', question: 'Semicolons or commas?' });
    expect(asked.questionId).toBeDefined();
    const [question] = h.take('deliver');
    expect(question).toMatchObject({ agentId: 'ada' });
    expect((question as { text: string }).text).toMatch(/Question from Linus \(Implementer\) — an agent, not the user/);
    h.send({ type: 'delivered', agentId: 'ada', deliveryId: (question as { deliveryId: string }).deliveryId });
    const answered = h.send({
      type: 'answer',
      by: 'ada',
      questionId: asked.questionId!,
      answer: 'Commas',
      deliver: true,
    });
    expect(answered.effects).toContainEqual({
      type: 'question-answered',
      questionId: asked.questionId,
      answer: 'Commas',
    });
    h.send({ type: 'agent-state', agentId: 'linus', state: 'idle' });
    const [answer] = h.take('deliver');
    expect(answer).toMatchObject({ agentId: 'linus' });
    expect((answer as { text: string }).text).toMatch(/From Ada \(an agent, not the user\) — answer to your question/);
  });

  it('a question to the user is a need; answering it resolves the need', () => {
    const h = new Harness(makeTask([planStage]));
    h.start();
    h.boot();
    h.deliverAll();
    const asked = h.send({ type: 'ask', from: 'ada', to: 'user', question: 'Which format?' });
    expect(h.run.needs).toMatchObject([{ kind: 'question', questionId: asked.questionId }]);
    h.send({ type: 'answer', by: 'user', questionId: asked.questionId!, answer: 'CSV', deliver: false });
    expect(h.run.needs).toEqual([]);
  });

  it('the advisor is consulted before the plan and its advice reaches the planner', () => {
    const task = makeTask([planStage]);
    const advisor = agentFromPreset('advisor', task.agents);
    task.agents.push(advisor);
    task.advisor = { agentId: advisor.id, moments: ['before-plan'], maxInterventions: 5 };
    const h = new Harness(task);
    h.start();
    expect(h.take('start-agent').map((e) => (e as { agentId: string }).agentId)).toEqual([advisor.id]);
    h.send({ type: 'agent-started', agentId: advisor.id, terminalId: 't1' });
    h.send({ type: 'agent-state', agentId: advisor.id, state: 'idle' });
    h.deliverAll();
    const sub = h.submit(advisor.id, { kind: 'advice', summary: 'Run the migration first', target: 'Ada' });
    expect(sub.error).toBeUndefined();
    expect(h.run.advice).toMatchObject([{ moment: 'before-plan', status: 'given', advice: 'Run the migration first' }]);
    h.boot();
    h.deliverAll();
    expect(h.run.agents['ada']!.assignment!.instruction).toMatch(/^Advice from the advisor/);
  });

  it('silent advice is recorded as a tick', () => {
    const task = makeTask([planStage]);
    const advisor = agentFromPreset('advisor', task.agents);
    task.agents.push(advisor);
    task.advisor = { agentId: advisor.id, moments: ['before-plan', 'before-done'], maxInterventions: 5 };
    const h = new Harness(task);
    h.start();
    h.boot();
    h.deliverAll();
    h.submit(advisor.id, { kind: 'advice', summary: 'no concerns', target: 'Ada' });
    h.boot();
    h.deliverAll();
    h.submit('ada', { kind: 'plan', summary: 'Plan' });
    // Before the end, the advisor is asked once more.
    expect(h.run.status).toBe('running');
    h.deliverAll();
    h.submit(advisor.id, { kind: 'advice', summary: 'Add a test for empty reports', target: 'user' });
    expect(h.run.status).toBe('done');
    expect(h.run.advice.map((a) => a.status)).toEqual(['silent', 'given']);
  });
});

describe('validateTask and persistence', () => {
  it('accepts the templates and reports problems inline', () => {
    for (const id of ['feature', 'bugfix', 'review', 'research', 'refactor', 'second-opinion', 'blank']) {
      const task = taskFromTemplate(id, { id: 't', projectId: 'p', now: 0 });
      expect(validateTask(task), id).toEqual([]);
    }
    const task = makeTask([
      { id: 'g', kind: 'gate', title: 'Gate', instruction: '', show: [], onReject: 'stop' },
      {
        id: 'p',
        kind: 'parallel',
        title: 'Par',
        instruction: '',
        agentIds: ['linus', 'grace'],
        output: 'review',
        join: 'all',
      },
      {
        id: 'l',
        kind: 'loop',
        title: 'Loop',
        instruction: '',
        workerId: 'linus',
        checkerId: 'linus',
        maxRounds: 2,
        checkerInstruction: '',
      },
    ]);
    const messages = validateTask(task).map((p) => p.message);
    expect(messages).toContainEqual(expect.stringMatching(/cannot start with an approval gate/));
    expect(messages).toContainEqual(expect.stringMatching(/must be read-only \(Linus\)/));
    expect(messages).toContainEqual(expect.stringMatching(/cannot review itself/));
  });

  it('keeps unknown fields when a record is read back', () => {
    const task = makeTask([planStage]);
    const raw: unknown = JSON.parse(
      JSON.stringify({ task: { ...task, future: 1 }, run: { ...initialRun(task), later: { a: 1 } } }),
    );
    const parsed = EnsembleRecordSchema.parse(raw);
    expect((parsed.task as Record<string, unknown>)['future']).toBe(1);
    expect((parsed.run as Record<string, unknown>)['later']).toEqual({ a: 1 });
  });
});
