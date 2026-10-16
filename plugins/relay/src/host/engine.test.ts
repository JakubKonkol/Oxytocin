import type { AgentLimits, AgentSnapshot } from '@oxytocin/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changedFiles,
  fillPrompt,
  filesText,
  type GitSnapshot,
  normalizeConfig,
  RelayEngine,
  RETRY_MS,
  SETTLE_MS,
} from './engine';

const agent = (
  terminalId: string,
  agentId: string,
  state: AgentSnapshot['state'],
  accountId = 'main',
  since = 1,
): AgentSnapshot => ({
  terminalId,
  projectId: 'p',
  agentId,
  displayName: agentId,
  provider: 'x',
  pid: 1,
  state,
  since,
  accountId,
});

const limits = (agent: AgentLimits['agent'], accountId: string, usedPercent: number, resetsAt = 1e13) => ({
  agent,
  accountId,
  windows: [{ window: 'five_hour', usedPercent, windowMinutes: 300, resetsAt, observedAt: 1 }],
});

function setup(snapshots: (GitSnapshot | null)[] = []) {
  const sent: { terminalId: string; text: string }[] = [];
  const notes: string[] = [];
  let result: { ok: true } | { ok: false; error: string } = { ok: true };
  const engine = new RelayEngine({
    send: (terminalId, text) => {
      sent.push({ terminalId, text });
      return Promise.resolve(result);
    },
    gitSnapshot: () => Promise.resolve(snapshots.shift() ?? null),
    notify: (_p, level, text) => notes.push(`${level}: ${text}`),
    changed: () => undefined,
  });
  engine.setAccounts([
    { id: 'main', agent: 'claude', name: 'main', main: true, home: '/h/.claude' },
    { id: 'main', agent: 'codex', name: 'main', main: true, home: '/h/.codex' },
    { id: 'acc_w', agent: 'codex', name: 'Work', main: false, home: '/h/acc/codex/work' },
  ]);
  return {
    engine,
    sent,
    notes,
    fail: (error: string) => (result = { ok: false, error }),
    succeed: () => (result = { ok: true }),
  };
}

/** Claude works, then stops; the turn settles. */
async function finishTurn(engine: RelayEngine, others: AgentSnapshot[], id = 'a', agentId = 'claude-code') {
  engine.update([agent(id, agentId, 'working'), ...others]);
  engine.update([agent(id, agentId, 'idle'), ...others]);
  await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Relay: hand-off at the limit', () => {
  const codexMain = agent('b', 'codex', 'idle', 'main', 2);
  const codexWork = agent('c', 'codex', 'idle', 'acc_w', 3);

  it('hands over to the next idle agent once a turn ends with the account nearly out', async () => {
    const { engine, sent, notes } = setup();
    engine.setConfig('p', { enabled: true, mode: 'handoff', handoffPrompt: 'Continue after {from}, see TODO.md.' });
    engine.setLimits([limits('claude', 'main', 95), limits('codex', 'main', 20), limits('codex', 'acc_w', 10)]);
    await finishTurn(engine, [codexMain, codexWork]);
    expect(sent).toEqual([{ terminalId: 'b', text: 'Continue after Claude (main), see TODO.md.' }]);
    expect(notes).toEqual(['info: Handed over from Claude (main) to Codex (main).']);
    expect(engine.view('p', 'api').log[1]?.text).toBe('Claude (main) finished its turn at 95% of the 5-hour limit.');
  });

  it('does nothing below the threshold, while the agent waits for the user, or when switched off', async () => {
    const { engine, sent } = setup();
    engine.setConfig('p', { enabled: true, threshold: 90 });
    engine.setLimits([limits('claude', 'main', 89)]);
    await finishTurn(engine, [codexMain]);
    engine.setLimits([limits('claude', 'main', 99)]);
    engine.update([agent('a', 'claude-code', 'working'), codexMain]);
    engine.update([agent('a', 'claude-code', 'idle'), codexMain]);
    engine.update([agent('a', 'claude-code', 'waiting'), codexMain]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    engine.setConfig('p', { enabled: false });
    await finishTurn(engine, [codexMain]);
    expect(sent).toEqual([]);
  });

  it('skips agents whose account is full too, in the chosen order', async () => {
    const { engine, sent } = setup();
    engine.setConfig('p', { enabled: true, order: ['a', 'c', 'b'] });
    engine.setLimits([limits('claude', 'main', 100), limits('codex', 'acc_w', 93), limits('codex', 'main', 5)]);
    await finishTurn(engine, [codexMain, codexWork]);
    expect(sent.map((s) => s.terminalId)).toEqual(['b']);
  });

  it('waits when nobody can take over, and goes back to the first agent once its limit started over', async () => {
    const { engine, sent, notes } = setup();
    engine.setConfig('p', { enabled: true });
    engine.setLimits([limits('claude', 'main', 97, 1e13), limits('codex', 'main', 96)]);
    await finishTurn(engine, [codexMain]);
    expect(sent).toEqual([]);
    expect(notes).toEqual([
      'warning: No agent can take over from Claude (main) yet (the others are busy or at their limit): Relay waits.',
    ]);
    expect(engine.view('p', 'api').pending).toMatch(/Waiting for an agent to take over/);
    // Claude's 5-hour window started over.
    engine.setLimits([limits('claude', 'main', 97, Date.now() - 1), limits('codex', 'main', 96)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((s) => s.terminalId)).toEqual(['a']);
    expect(engine.view('p', 'api').pending).toBeNull();
  });

  it('retries an agent that refused the prompt only after a while', async () => {
    const { engine, sent, fail, succeed } = setup();
    engine.setConfig('p', { enabled: true });
    engine.setLimits([limits('claude', 'main', 95)]);
    fail('A question is open in its terminal (trust, login, yes/no).');
    await finishTurn(engine, [codexMain]);
    expect(sent).toHaveLength(1);
    engine.update([agent('a', 'claude-code', 'idle'), codexMain]);
    expect(sent).toHaveLength(1);
    succeed();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
    expect(sent).toHaveLength(2);
    expect(engine.view('p', 'api').pending).toBeNull();
  });
});

describe('Relay: review after each turn', () => {
  const reviewer = agent('r', 'codex', 'idle', 'acc_w', 2);
  const before: GitSnapshot = new Map([['a.ts', 'M:1:0']]);
  const after: GitSnapshot = new Map([
    ['a.ts', 'M:3:1'],
    ['b.ts', 'A:10:0'],
  ]);

  it('asks the reviewer to review a turn that changed files, naming them', async () => {
    const { engine, sent, notes } = setup([before, after]);
    engine.setConfig('p', { enabled: true, mode: 'review', reviewer: 'r', reviewPrompt: 'Review {from}: {files}.' });
    await finishTurn(engine, [reviewer]);
    expect(sent).toEqual([{ terminalId: 'r', text: 'Review Claude (main): a.ts, b.ts.' }]);
    expect(notes).toEqual(['info: Asked Codex (Work) to review the changes of Claude (main).']);
    // The reviewer's own turn triggers nothing.
    await finishTurn(engine, [agent('a', 'claude-code', 'idle')], 'r', 'codex');
    expect(sent).toHaveLength(1);
  });

  it('skips turns without changes and reviews turns that end while the reviewer works together', async () => {
    const { engine, sent } = setup([before, before, before, after]);
    engine.setConfig('p', { enabled: true, mode: 'review', reviewer: 'r' });
    await finishTurn(engine, [reviewer]);
    expect(sent).toEqual([]);
    expect(engine.view('p', 'api').log[0]?.text).toMatch(/without changing files: no review/);

    const busy = { ...reviewer, state: 'working' as const };
    await finishTurn(engine, [busy]);
    expect(sent).toEqual([]);
    expect(engine.view('p', 'api').pending).toMatch(/reviewer/);
    engine.update([agent('a', 'claude-code', 'idle'), reviewer]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Changed files: a.ts, b.ts.');
  });
});

describe('Relay: review without git', () => {
  it('reviews every finished turn when it cannot tell what changed', async () => {
    const { engine, sent } = setup([null, null]);
    engine.setConfig('p', { enabled: true, mode: 'review', reviewer: 'r', reviewPrompt: 'Review: {files}' });
    await finishTurn(engine, [agent('r', 'codex', 'idle', 'acc_w', 2)]);
    expect(sent).toEqual([{ terminalId: 'r', text: 'Review: see git status' }]);
  });
});

describe('Relay helpers', () => {
  it('fills prompts, lists changed files and keeps the configuration in bounds', () => {
    expect(fillPrompt(' {from} → {to} ({limit}) {unknown} ', { from: 'A', to: 'B', limit: '91%' })).toBe(
      'A → B (91%) {unknown}',
    );
    expect(changedFiles(null, new Map([['x', '1']]))).toEqual(['x']);
    expect(changedFiles(new Map([['gone', '1']]), new Map())).toEqual(['gone']);
    expect(filesText([])).toBe('see git status');
    expect(filesText(Array.from({ length: 17 }, (_, i) => `f${i}`))).toMatch(/f14 and 2 more$/);
    const c = normalizeConfig({ threshold: 400, handoffPrompt: '  ', mode: 'nope' as never, order: ['a', 3 as never] });
    expect(c).toMatchObject({ threshold: 100, mode: 'handoff', order: ['a'], enabled: false });
    expect(c.handoffPrompt).toMatch(/\{from\}/);
  });

  it('numbers agents of the same account', () => {
    const { engine } = setup();
    engine.update([agent('x', 'codex', 'idle', 'main', 1), agent('y', 'codex', 'idle', 'main', 2)]);
    expect(engine.view('p', 'api').participants.map((p) => p.label)).toEqual(['Codex (main) #1', 'Codex (main) #2']);
  });
});
