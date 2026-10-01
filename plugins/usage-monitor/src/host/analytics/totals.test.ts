import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageEngine } from '../engine';
import { emptyTokens, type UsageRecord } from '../model';

let dir: string;
let engine: UsageEngine;
const now = new Date(2026, 8, 26, 10, 0).getTime();

const record = (id: string, sessionId: string, output: number): UsageRecord => ({
  id,
  ts: now - 60_000,
  agent: 'claude-code',
  provider: 'anthropic',
  rawModel: 'claude-opus-5-5',
  sessionId,
  cwd: '/p1',
  tokens: { ...emptyTokens(), output },
  source: 'claude-jsonl',
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-totals-'));
  engine = await UsageEngine.create({ dbPath: ':memory:', storageDir: dir, now: () => now });
  engine.setSettings({ pricingAutoUpdate: false, costMode: 'calculate' });
});
afterEach(async () => {
  engine.close();
  await rm(dir, { recursive: true, force: true });
});

describe('totals per group (Ensemble agents)', () => {
  it('sums cost and tokens by session ids or terminal ids, counting each event once', () => {
    engine.setAgentSessions([{ sessionId: 's2', terminalId: 't2' }]);
    engine.ingest([record('a', 's1', 100_000), record('b', 's2', 50_000), record('c', 's3', 10_000)]);
    const totals = engine.totals([
      { key: 'ada', sessionIds: ['s1'] },
      // s2 matches both by session and by terminal: counted once.
      { key: 'linus', sessionIds: ['s2'], terminalIds: ['t2'] },
      { key: 'grace', terminalIds: ['t-unknown'] },
      { key: 'empty' },
    ]);
    expect(totals['ada']!.tokens).toBe(100_000);
    expect(totals['ada']!.costUsd).toBeGreaterThan(0);
    expect(totals['linus']!.tokens).toBe(50_000);
    expect(totals['linus']!.costUsd).toBeCloseTo(totals['ada']!.costUsd / 2, 6);
    expect(totals['grace']).toEqual({ costUsd: 0, tokens: 0 });
    expect(totals['empty']).toBeUndefined();
  });
});
