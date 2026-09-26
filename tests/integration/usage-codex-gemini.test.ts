import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageEngine } from '../../plugins/usage-monitor/src/host/engine';

const fixtures = resolve(__dirname, '../fixtures/usage');
interface Expected {
  sources: Record<string, { events: number; tokens: Record<string, number>; costUsdAuto: number }>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expected = require('../fixtures/usage/expected.json') as Expected;

let temp: string;
let engine: UsageEngine;

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'oxy-usage-cg-'));
  await cp(join(fixtures, 'codex'), join(temp, 'codex'), { recursive: true });
  await cp(join(fixtures, 'gemini'), join(temp, 'gemini'), { recursive: true });
  engine = await UsageEngine.create({
    dbPath: ':memory:',
    storageDir: join(temp, 'storage'),
    env: { CODEX_HOME: join(temp, 'codex/home'), GEMINI_CLI_HOME: join(temp, 'gemini/home') },
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

function totals(source: string) {
  const t = engine.db
    .prepare(
      `SELECT count(*) AS events, sum(input_tokens) AS input, sum(output_tokens) AS output,
              sum(cache_read_tokens) AS cacheRead, sum(cache_write_5m_tokens) AS cacheWrite5m,
              sum(cache_write_1h_tokens) AS cacheWrite1h, sum(reasoning_tokens) AS reasoning,
              sum(cost_usd) AS cost
         FROM usage_events WHERE source = ?`,
    )
    .get(source) as Record<string, number>;
  const { events, cost, ...tokens } = t;
  return { events, cost, tokens };
}

describe('Codex and Gemini collectors', () => {
  it('ingest the fixtures to the reference totals and costs', async () => {
    await engine.startCollectors({ claudeCode: false, codex: true, gemini: true, backfillDays: 30 });
    for (const source of ['codex-rollout', 'gemini-chat']) {
      const ref = expected.sources[source]!;
      const t = totals(source);
      expect(t.events, source).toBe(ref.events);
      expect(t.tokens, source).toEqual(ref.tokens);
      expect(t.cost, source).toBeCloseTo(ref.costUsdAuto, 4);
    }
    // Codex rate limits: the latest observation per window.
    expect(engine.db.prepare('SELECT window, used_percent FROM agent_limits ORDER BY window').all()).toEqual([
      { window: 'primary', used_percent: 18 },
      { window: 'secondary', used_percent: 41 },
    ]);
  });

  it('attributes Gemini sessions by project hash and links sessions to terminals', async () => {
    await engine.startCollectors({ claudeCode: false, codex: true, gemini: true, backfillDays: 30 });
    engine.setProjects([{ id: 'p1', rootPath: '/fixture/proj' }]);
    expect(
      engine.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE source = 'gemini-chat' AND project_id = 'p1'")
        .get(),
    ).toEqual({ n: expected.sources['gemini-chat']!.events });

    const links: string[] = [];
    engine.onSessionLinked((l) => links.push(`${l.terminalId}:${l.sessionId}`));
    engine.setAgents([
      // Codex started at 19:00:00 in /fixture/proj → codex-s1 (session_meta 19:00:00).
      {
        terminalId: 't-codex',
        agentId: 'codex',
        projectId: 'p1',
        since: Date.parse('2026-09-26T18:59:58Z'),
        cwd: '/fixture/proj',
      },
      // Two Gemini agents in the same project at the same time: ambiguous → not linked.
      { terminalId: 't-g1', agentId: 'gemini-cli', projectId: 'p1', since: Date.parse('2026-09-26T19:59:59Z') },
      { terminalId: 't-g2', agentId: 'gemini-cli', projectId: 'p1', since: Date.parse('2026-09-26T20:00:10Z') },
    ]);
    expect(links).toEqual(['t-codex:codex-s1']);
    expect(
      engine.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE session_id = 'codex-s1' AND terminal_id = 't-codex'")
        .get(),
    ).toEqual({ n: 3 });
    expect(engine.db.prepare("SELECT terminal_id FROM sessions WHERE session_id = 'gem00001-aaaa'").get()).toEqual({
      terminal_id: null,
    });
  });
});
