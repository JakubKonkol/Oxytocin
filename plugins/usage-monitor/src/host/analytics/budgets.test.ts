import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageEngine } from '../engine';
import { emptyTokens, type UsageRecord } from '../model';

let dir: string;
let engine: UsageEngine;
let now = new Date(2026, 8, 26, 10, 0).getTime();

const record = (id: string, ts: number, output: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  id,
  ts,
  agent: 'claude-code',
  provider: 'anthropic',
  rawModel: 'claude-opus-5-5',
  sessionId: 's1',
  cwd: '/p1',
  tokens: { ...emptyTokens(), output },
  source: 'claude-jsonl',
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-budgets-'));
  now = new Date(2026, 8, 26, 10, 0).getTime();
  engine = await UsageEngine.create({
    dbPath: ':memory:',
    storageDir: dir,
    now: () => now,
    caseInsensitivePaths: false,
  });
  engine.setSettings({ pricingAutoUpdate: false, costMode: 'calculate' });
  engine.setProjects([{ id: 'p1', rootPath: '/p1', name: 'api' }]);
});
afterEach(async () => {
  engine.close();
  await rm(dir, { recursive: true, force: true });
});

describe('budgets and thresholds (fake time)', () => {
  it('evaluates a daily USD budget, fires 80% and 100% once per day and projects exhaustion', () => {
    const budget = engine.saveBudget({ name: 'Daily', scope: 'global', period: 'day', metric: 'usd', amount: 5 });
    expect(budget.thresholds).toEqual([0.8, 1]);
    // 150k output tokens of opus-5-5 = $3.00 (60%).
    engine.ingest([record('a', now - 30 * 60_000, 150_000)]);
    expect(engine.checkBudgets()).toEqual([]);
    const [status] = engine.budgets();
    expect(status!.ratio).toBeCloseTo(0.6, 6);
    // $3/h over the last hour → the remaining $2 last 40 minutes.
    expect(status!.exhaustedAt).toBe(now + 40 * 60_000);

    engine.ingest([record('b', now - 60_000, 50_000)]); // +$1 → 80%
    expect(engine.checkBudgets().map((a) => a.threshold)).toEqual([0.8]);
    expect(engine.checkBudgets()).toEqual([]);
    engine.ingest([record('c', now, 60_000)]); // +$1.20 → 104%
    const alerts = engine.checkBudgets();
    expect(alerts).toEqual([expect.objectContaining({ name: 'Daily', threshold: 1, amount: 5, metric: 'usd' })]);
    expect(alerts[0]!.spent).toBeCloseTo(5.2, 6);
    expect(engine.checkBudgets()).toEqual([]);

    // Next day: a new period, alerts can fire again.
    now = new Date(2026, 8, 27, 9, 0).getTime();
    engine.ingest([record('d', now, 250_000)]);
    expect(engine.checkBudgets().map((a) => a.threshold)).toEqual([1]);
  });

  it('tracks a 5-hour block budget in tokens and a project budget', () => {
    engine.saveBudget({
      name: 'Block',
      scope: 'global',
      period: 'block5h',
      metric: 'tokens',
      amount: 1000,
      thresholds: [0.5],
    });
    engine.saveBudget({ name: 'API', scope: 'project', scopeRef: 'p1', period: 'week', metric: 'usd', amount: 100 });
    expect(() =>
      engine.saveBudget({ name: 'Bad', scope: 'project', period: 'day', metric: 'usd', amount: 1 }),
    ).toThrow();
    const start = new Date(2026, 8, 26, 9, 12).getTime();
    engine.ingest([record('a', start, 400), record('b', start + 60 * 60_000, 200)]);
    const block = engine.budgets().find((s) => s.budget.name === 'Block')!;
    expect(block.spent).toBe(600);
    expect(block.range).toEqual({ from: new Date(2026, 8, 26, 9).getTime(), to: new Date(2026, 8, 26, 14).getTime() });
    expect(engine.checkBudgets().map((a) => a.name)).toEqual(['Block']);
    // After the block ended nothing is active.
    now = new Date(2026, 8, 26, 14, 30).getTime();
    expect(engine.budgets().find((s) => s.budget.name === 'Block')!.spent).toBe(0);
  });
});

describe('sidebar model', () => {
  it('shows today, live sessions and picks the limit bar by priority', () => {
    engine.ingest([
      record('a', now - 5 * 60_000, 100_000),
      record('b', now - 2 * 60 * 60_000, 50_000, { sessionId: 's-old' }),
      record('x', now - 3 * 24 * 60 * 60_000, 50_000, { sessionId: 's-older' }),
    ]);
    engine.activeProjectId = 'p1';
    engine.setAgents([
      {
        terminalId: 't1',
        agentId: 'claude-code',
        projectId: 'p1',
        since: now - 60 * 60_000,
        sessionId: 's1',
        state: 'working',
      },
    ]);
    let model = engine.sidebar();
    expect(model.today.costUsd).toBeCloseTo(3, 6);
    expect(model.sessions.map((s) => [s.sessionId, s.state, s.projectName, s.terminalId])).toEqual([
      ['s1', 'working', 'api', 't1'],
    ]);
    expect(model.project).toMatchObject({ id: 'p1', name: 'api' });
    expect(model.project!.last7DaysUsd).toBeCloseTo(4, 6);
    expect(model.limit).toBeNull();

    engine.saveBudget({ name: 'Weekly', scope: 'global', period: 'week', metric: 'usd', amount: 100 });
    engine.saveBudget({ name: 'Daily', scope: 'global', period: 'day', metric: 'usd', amount: 10 });
    model = engine.sidebar();
    expect(model.limit).toMatchObject({ kind: 'global-budget', label: '30% of daily budget ($10.00)' });
    expect(model.limits).toHaveLength(2);

    engine.saveBudget({ name: 'API', scope: 'project', scopeRef: 'p1', period: 'day', metric: 'usd', amount: 4 });
    expect(engine.sidebar().limit).toMatchObject({ kind: 'project-budget', label: '75% of api daily budget ($4.00)' });

    // Agent plan limits are shown per account, apart from the budgets.
    engine.ingest([
      {
        kind: 'limit',
        agent: 'claude-code',
        window: 'primary',
        usedPercent: 64,
        windowMinutes: 300,
        resetsAt: now + 3_600_000,
        observedAt: now,
      },
    ]);
    expect(engine.sidebar().limit).toMatchObject({ kind: 'project-budget' });
    expect(engine.sidebar().accountLimits).toEqual([
      {
        agent: 'claude-code',
        account: 'main',
        label: 'Claude (main)',
        bars: [expect.objectContaining({ kind: 'agent-limit', label: '64% of 5h limit', ratio: 0.64 })],
      },
    ]);
    expect(engine.status()).toMatchObject({ busy: false, activeSession: { agent: 'claude-code' } });
  });

  it('shows the Claude block when an own block limit is set, and marks subscription amounts', () => {
    engine.setSettings({ claudeBlockLimit: { metric: 'usd', amount: 10 }, billing: { 'claude-code': 'subscription' } });
    engine.ingest([record('a', now - 60_000, 100_000)]);
    const model = engine.sidebar();
    expect(model.limit).toMatchObject({ kind: 'claude-block', label: '20% of Claude 5-hour block limit' });
    expect(model.today.approximate).toBe(true);
    expect(engine.status()).toMatchObject({ approximate: true, busy: false });
    now += 1000;
    engine.ingest([record('b', now, 1)]);
    expect(engine.status().busy).toBe(true);
  });

  it('hides costs only when every agent in use is billed by subscription', () => {
    // No usage yet: the Claude Code billing decides.
    expect(engine.sidebar().subscriptionOnly).toBe(false);
    engine.setSettings({ billing: { 'claude-code': 'subscription' } });
    expect(engine.sidebar().subscriptionOnly).toBe(true);

    engine.ingest([record('a', now - 60_000, 100_000)]);
    expect(engine.sidebar().subscriptionOnly).toBe(true);
    expect(engine.status()).toMatchObject({
      subscriptionOnly: true,
      tokens: { today: 100_000, week: 100_000, month: 100_000 },
    });

    // A Codex session billed by the API in the last 7 days brings the costs back.
    engine.ingest([
      record('b', now - 3 * 86_400_000, 10, {
        agent: 'codex',
        provider: 'openai',
        sessionId: 's2',
        source: 'codex-rollout',
      }),
    ]);
    expect(engine.sidebar().subscriptionOnly).toBe(false);
    engine.setSettings({ billing: { 'claude-code': 'subscription', codex: 'subscription' } });
    expect(engine.sidebar().subscriptionOnly).toBe(true);
    expect(engine.status().subscriptionOnly).toBe(true);
  });

  it('shows Claude subscription limits as their own bars and in the status model', () => {
    const limit = (window: string, used: number, minutes: number, resetsAt: number) => ({
      kind: 'limit' as const,
      agent: 'claude-code',
      window,
      usedPercent: used,
      windowMinutes: minutes,
      resetsAt,
      observedAt: now,
    });
    engine.ingest([
      limit('seven_day', 41.2, 10080, now + 3 * 86_400_000),
      limit('five_hour', 23.5, 300, now + 3_600_000),
      limit('five_hour_old', 90, 300, now - 1),
    ]);
    // API billing: the plan limits are shown per account, not in the status bar.
    expect(engine.sidebar().subscriptionLimits).toEqual([]);
    expect(engine.sidebar().limit).toBeNull();
    expect(engine.sidebar().accountLimits[0]!.bars.map((b) => [b.window, b.label, b.resetsAt])).toEqual([
      ['five_hour', '24% of 5h limit', now + 3_600_000],
      // Started over since the reading.
      ['five_hour_old', '0% of 5h limit', null],
      ['seven_day', '41% of weekly limit', now + 3 * 86_400_000],
    ]);

    engine.setSettings({ billing: { 'claude-code': 'subscription' } });
    const model = engine.sidebar();
    expect(model.subscriptionLimits.map((b) => [b.window, b.label])).toEqual([
      ['five_hour', 'Claude: 24% of 5h limit'],
      ['seven_day', 'Claude: 41% of weekly limit'],
    ]);
    expect(model.subscriptionLimits[0]).toMatchObject({ ratio: 0.235, resetsAt: now + 3_600_000, observedAt: now });
    expect(model.limit).toBeNull();
    expect(engine.status().subscriptionLimits).toEqual([
      { window: 'five_hour', percent: 24, resetsAt: now + 3_600_000 },
      { window: 'seven_day', percent: 41, resetsAt: now + 3 * 86_400_000 },
    ]);
  });

  it('tells the accounts apart: limits per account, attributed by the account folders', () => {
    engine.setAccounts([
      { agent: 'claude-code', id: 'main', name: 'main', home: '/h/.claude' },
      { agent: 'claude-code', id: 'acc_w', name: 'Work', home: '/h/.oxytocin/accounts/claude/work/' },
      { agent: 'codex', id: 'main', name: 'main', home: '/h/.codex' },
      { agent: 'codex', id: 'acc_s', name: 'Side', home: '/h/.oxytocin/accounts/codex/side' },
    ]);
    expect(engine.accountOfPath('claude-code', '/h/.oxytocin/accounts/claude/work/projects/-p/s.jsonl')).toBe('acc_w');
    expect(engine.accountOfPath('claude-code', '/h/.oxytocin/accounts/claude/workshop/x.jsonl')).toBe('main');
    expect(engine.accountOfPath('codex', '/h/.oxytocin/accounts/codex/side/sessions/r.jsonl')).toBe('acc_s');
    expect(engine.accountOfPath('codex', '/h/.codex/sessions/r.jsonl')).toBe('main');
    let fired = 0;
    engine.onLimitsChanged(() => fired++);
    const limit = (agent: string, account: string, window: string, used: number, minutes: number) => ({
      kind: 'limit' as const,
      agent,
      account,
      window,
      usedPercent: used,
      windowMinutes: minutes,
      resetsAt: now + 49 * 60_000,
      observedAt: now - 60_000,
    });
    engine.ingest([
      limit('codex', 'main', 'primary', 12, 300),
      limit('claude-code', 'acc_w', 'five_hour', 75, 300),
      limit('claude-code', 'main', 'five_hour', 28, 300),
      limit('claude-code', 'gone', 'five_hour', 99, 300),
    ]);
    expect(fired).toBe(1);
    expect(engine.sidebar().accountLimits.map((g) => [g.label, g.bars.map((b) => b.label)])).toEqual([
      ['Claude (main)', ['28% of 5h limit']],
      ['Claude (Work)', ['75% of 5h limit']],
      ['Codex (main)', ['12% of 5h limit']],
    ]);
    expect(engine.accountLimits()).toEqual([
      {
        agent: 'claude',
        accountId: 'acc_w',
        windows: [
          {
            window: 'five_hour',
            usedPercent: 75,
            windowMinutes: 300,
            resetsAt: now + 49 * 60_000,
            observedAt: now - 60_000,
          },
        ],
      },
      expect.objectContaining({ agent: 'claude', accountId: 'main' }),
      expect.objectContaining({ agent: 'codex', accountId: 'main' }),
    ]);
  });
});
