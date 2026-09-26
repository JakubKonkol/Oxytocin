import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageEngine } from '../../plugins/usage-monitor/src/host/engine';

const fixtures = resolve(__dirname, '../fixtures/usage');
interface Expected {
  sources: Record<
    string,
    {
      events: number;
      tokens: Record<string, number>;
      costUsdAuto: number;
      costUsdCalculated: number;
      byModel: Record<string, { events: number }>;
    }
  >;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expected = require('../fixtures/usage/expected.json') as Expected;

let temp: string;
let engine: UsageEngine;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'oxy-usage-claude-'));
  await cp(join(fixtures, 'claude'), join(temp, 'claude'), { recursive: true });
  engine = await UsageEngine.create({
    dbPath: ':memory:',
    storageDir: join(temp, 'storage'),
    env: { CLAUDE_CONFIG_DIR: join(temp, 'claude/home') },
    home: join(temp, 'nohome'),
    now: () => Date.parse('2026-09-27T00:00:00Z'),
    caseInsensitivePaths: false,
  });
  engine.setSettings({ pricingAutoUpdate: false });
});
afterEach(async () => {
  engine.close();
  await rm(temp, { recursive: true, force: true });
});

function totals() {
  return engine.db
    .prepare(
      `SELECT count(*) AS events, sum(input_tokens) AS input, sum(output_tokens) AS output,
              sum(cache_read_tokens) AS cacheRead, sum(cache_write_5m_tokens) AS cacheWrite5m,
              sum(cache_write_1h_tokens) AS cacheWrite1h, sum(reasoning_tokens) AS reasoning,
              sum(cost_usd) AS cost
         FROM usage_events WHERE source = 'claude-jsonl'`,
    )
    .get() as Record<string, number> & { events: number };
}

describe('Claude Code collector', () => {
  it('backfills the fixtures to the reference totals and costs', async () => {
    const progress: number[] = [];
    engine.onProgress((_s, done, total) => progress.push(done / total));
    await engine.startCollectors({ claudeCode: true, backfillDays: 30 });
    const ref = expected.sources['claude-jsonl']!;
    const t = totals();
    expect(t.events).toBe(ref.events);
    expect({
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite5m: t.cacheWrite5m,
      cacheWrite1h: t.cacheWrite1h,
      reasoning: t.reasoning,
    }).toEqual(ref.tokens);
    expect(t.cost).toBeCloseTo(ref.costUsdAuto, 4);
    expect(progress.at(-1)).toBe(1);

    // Placeholder output counts are replaced by the final value; the unknown model has no cost.
    const e1 = engine.db
      .prepare("SELECT output_tokens, cost_usd FROM usage_events WHERE id = 'claude:msg_E1:req_E1'")
      .get();
    expect(e1).toMatchObject({ output_tokens: 500 });
    expect(
      engine.db.prepare("SELECT cost_usd, model FROM usage_events WHERE raw_model = 'claude-mystery-9'").get(),
    ).toEqual({ cost_usd: null, model: 'claude-mystery-9' });
    expect(
      engine.db.prepare("SELECT model FROM usage_events WHERE raw_model = 'claude-sonnet-4-5-20250929'").get(),
    ).toEqual({ model: 'claude-sonnet-4-5' });

    // Switching the cost mode recomputes: the reported cost of the old line is replaced by the calculated one.
    engine.setSettings({ costMode: 'calculate' });
    expect(totals().cost).toBeCloseTo(ref.costUsdCalculated, 4);
  });

  it('attributes projects and terminals and picks up appended lines within a second', async () => {
    await engine.startCollectors({ claudeCode: true, backfillDays: 30 });
    engine.setProjects([{ id: 'p1', rootPath: '/fixture/proj' }]);
    expect(engine.db.prepare("SELECT count(*) AS n FROM usage_events WHERE project_id = 'p1'").get()).toEqual({
      n: expected.sources['claude-jsonl']!.events,
    });
    engine.setAgentSessions([{ sessionId: 'edge-0001', terminalId: 't-1' }]);
    expect(engine.db.prepare("SELECT terminal_id FROM sessions WHERE session_id = 'edge-0001'").get()).toEqual({
      terminal_id: 't-1',
    });
    expect(
      engine.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE session_id = 'edge-0001' AND terminal_id = 't-1'")
        .get(),
    ).toEqual({ n: 7 });

    // The fixture's last line is unterminated: completing it makes it count.
    const before = totals().events;
    const changed = new Promise<number>((r) => engine.onDidChange(() => r(Date.now())));
    const start = Date.now();
    await appendFile(join(temp, 'claude/home/projects/-fixture-proj/edge-0001.jsonl'), '\n');
    const at = await changed;
    expect(at - start).toBeLessThan(1000);
    expect(totals().events).toBe(before + 1);
    // New events of a known session get its terminal right away.
    expect(engine.db.prepare("SELECT terminal_id FROM usage_events WHERE id = 'claude:msg_E6:req_E6'").get()).toEqual({
      terminal_id: 't-1',
    });
  });
});
