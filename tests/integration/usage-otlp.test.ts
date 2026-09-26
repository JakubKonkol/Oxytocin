import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeExport } from '../../plugins/usage-monitor/src/host/collectors/otlp-test-payloads';
import { detectUserOtelConfig, OTLP_PRIMARY_WAIT_MS, UsageEngine } from '../../plugins/usage-monitor/src/host/engine';

const fixtures = resolve(__dirname, '../fixtures/usage');
let temp: string;
let engine: UsageEngine;
let now = Date.parse('2026-09-27T00:00:00Z');

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'oxy-usage-otlp-'));
  await cp(join(fixtures, 'claude'), join(temp, 'claude'), { recursive: true });
  now = Date.parse('2026-09-27T00:00:00Z');
  engine = await UsageEngine.create({
    dbPath: ':memory:',
    storageDir: join(temp, 'storage'),
    env: { CLAUDE_CONFIG_DIR: join(temp, 'claude/home') },
    home: join(temp, 'nohome'),
    now: () => now,
    caseInsensitivePaths: false,
  });
  engine.setSettings({ pricingAutoUpdate: false });
  await engine.startCollectors({ claudeCode: true, codex: false, gemini: false, backfillDays: 30 });
});
afterEach(async () => {
  engine.close();
  await rm(temp, { recursive: true, force: true });
});

const count = (where = '1 = 1') =>
  (engine.db.prepare(`SELECT count(*) AS n FROM usage_events WHERE ${where}`).get() as { n: number }).n;

async function post(port: number, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
  });
  return res.status;
}

describe('OTLP receiver', () => {
  it('requires the token, accepts JSON and gzip, rejects protobuf', async () => {
    const endpoint = (await engine.configureOtlp(true))!;
    const auth = { authorization: `Bearer ${endpoint.token}` };
    const payload = claudeExport('otel-1', 't-9', { input: 1, output: 2 }, 0.001);
    expect(await post(endpoint.port, payload, {})).toBe(401);
    expect(await post(endpoint.port, payload, { authorization: 'Bearer nope' })).toBe(401);
    expect(await post(endpoint.port, payload, auth)).toBe(200);
    expect(await post(endpoint.port, gzipSync(JSON.stringify(payload)), { ...auth, 'content-encoding': 'gzip' })).toBe(
      200,
    );
    expect(await post(endpoint.port, 'x', { ...auth, 'content-type': 'application/x-protobuf' })).toBe(415);
    expect(await post(endpoint.port, '{broken', auth)).toBe(400);
    expect(engine.otlpStats).toMatchObject({ packets: 2 });
    // The same port and token come back after a restart of the receiver.
    await engine.configureOtlp(false);
    expect(await engine.configureOtlp(true)).toEqual(endpoint);
  });

  it('counts each session from one source only', async () => {
    const before = count();
    // edge-0001 is known from its transcript: OTLP only adds attribution and the reported cost.
    engine.ingestOtlp(claudeExport('edge-0001', 't-5', { input: 100, output: 100 }, 0.25));
    expect(count()).toBe(before);
    expect(
      engine.db.prepare("SELECT terminal_id, reported_cost_usd FROM sessions WHERE session_id = 'edge-0001'").get(),
    ).toEqual({
      terminal_id: 't-5',
      reported_cost_usd: 0.25,
    });
    expect(count("session_id = 'edge-0001' AND terminal_id = 't-5'")).toBe(7);

    // A session seen only through OTLP counts after the 15 s grace period.
    engine.ingestOtlp(claudeExport('otel-only', null, { input: 10, output: 20, cacheRead: 30 }, 0.1));
    expect(count("session_id = 'otel-only'")).toBe(0);
    now += OTLP_PRIMARY_WAIT_MS;
    engine.flushPendingOtel();
    expect(
      engine.db.prepare("SELECT source, input_tokens, cost_usd FROM usage_events WHERE session_id = 'otel-only'").all(),
    ).toEqual([{ source: 'claude-otel', input_tokens: 10, cost_usd: 0.1 }]);

    // OTLP first, then the transcript within 15 s: the transcript wins and the buffered OTLP data is dropped.
    engine.ingestOtlp(claudeExport('late', null, { input: 5, output: 5 }, 0.01));
    const line = {
      type: 'assistant',
      timestamp: '2026-09-26T23:59:00.000Z',
      sessionId: 'late',
      uuid: 'late-1',
      requestId: 'req_late',
      cwd: '/fixture/proj',
      message: { id: 'msg_late', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 5 } },
    };
    await appendFile(join(temp, 'claude/home/projects/-fixture-proj/late.jsonl'), `${JSON.stringify(line)}\n`);
    await engine.collectors.get('claude-jsonl')!.rescan();
    now += OTLP_PRIMARY_WAIT_MS;
    engine.flushPendingOtel();
    expect(engine.db.prepare("SELECT source FROM usage_events WHERE session_id = 'late'").all()).toEqual([
      { source: 'claude-jsonl' },
    ]);

    // …and transcript lines of an OTLP-primary session are ignored.
    await appendFile(
      join(temp, 'claude/home/projects/-fixture-proj/otel-only.jsonl'),
      `${JSON.stringify({ ...line, sessionId: 'otel-only', uuid: 'o-1', requestId: 'req_o', message: { ...line.message, id: 'msg_o' } })}\n`,
    );
    await engine.collectors.get('claude-jsonl')!.rescan();
    expect(count("session_id = 'otel-only'")).toBe(1);
  });

  it('detects an existing OpenTelemetry configuration', () => {
    expect(detectUserOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x' }, temp)).toMatch(
      /OTEL_EXPORTER_OTLP_ENDPOINT/,
    );
    expect(detectUserOtelConfig({}, temp)).toBeNull();
  });
});
