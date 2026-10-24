import { describe, expect, it } from 'vitest';
import type { McpToolResult } from '@shared/domain/mcp';
import { CodeMapUsage, MAX_USAGE_EVENTS_PER_SESSION, MAX_USAGE_SESSIONS, resultChars } from './code-map-usage';

const text = (t: string): McpToolResult => ({ content: [{ type: 'text', text: t }] });
const call = (o: Partial<Parameters<CodeMapUsage['record']>[0]> = {}): Parameters<CodeMapUsage['record']>[0] => ({
  sessionId: 's1',
  terminalId: 't1',
  projectId: 'p1',
  tool: 'oxy_find_code',
  at: 1000,
  result: text('abcde'),
  failed: false,
  ...o,
});

describe('CodeMapUsage', () => {
  it('counts calls, answer characters, stale and not-OK answers and errors per session and tool', () => {
    const usage = new CodeMapUsage();
    usage.record(call());
    usage.record(call({ at: 2000, result: text('x'.repeat(95)), report: { stale: true } }));
    usage.record(
      call({ at: 3000, tool: 'oxy_file_outline', result: text('INDEX_UPDATING: wait'), report: { notOk: true } }),
    );
    usage.record(call({ at: 4000, tool: 'oxy_task_context', result: text('Invalid'), failed: true }));
    usage.record(call({ sessionId: 's2', terminalId: undefined, projectId: undefined, at: 5000 }));
    const [second, first] = usage.snapshot();
    expect(first).toMatchObject({
      sessionId: 's1',
      terminalId: 't1',
      projectId: 'p1',
      firstAt: 1000,
      lastAt: 4000,
      calls: 4,
      chars: 5 + 95 + 'INDEX_UPDATING: wait'.length + 'Invalid'.length,
      stale: 1,
      notOk: 1,
      errors: 1,
    });
    expect(first!.tools['oxy_find_code']).toEqual({ calls: 2, chars: 100, stale: 1, notOk: 0, errors: 0 });
    expect(first!.tools['oxy_file_outline']).toMatchObject({ calls: 1, notOk: 1 });
    expect(first!.tools['oxy_task_context']).toMatchObject({ calls: 1, errors: 1 });
    expect(second).toMatchObject({ sessionId: 's2', terminalId: null, projectId: null, calls: 1 });
  });

  it('counts only text and keeps the terminal once it is known', () => {
    expect(
      resultChars({
        content: [
          { type: 'text', text: 'ab' },
          { type: 'image', data: 'x'.repeat(1000), mimeType: 'image/png' },
          { type: 'text', text: 'cd' },
        ],
      }),
    ).toBe(4);
    const usage = new CodeMapUsage();
    usage.record(call({ terminalId: undefined }));
    usage.record(call({ terminalId: 't9', at: 2000 }));
    usage.record(call({ terminalId: 't10', at: 3000 }));
    expect(usage.snapshot()[0]!.terminalId).toBe('t9');
  });

  it('stores no query text, path or code: only counters, identifiers and the tool name', () => {
    const usage = new CodeMapUsage();
    usage.record(
      call({
        result: text('src/secret/PaymentGateway.ts:3-9 function chargeCard(token)'),
        report: { stale: true },
      }),
    );
    const stored = JSON.stringify([
      usage.snapshot(),
      usage.totals([{ key: 'k', terminalId: 't1', from: 0, to: 9999 }]),
    ]);
    for (const leaked of ['secret', 'PaymentGateway', 'chargeCard', 'token']) expect(stored).not.toContain(leaked);
  });

  it('is bounded: the least recently used session goes first, and each session keeps its latest calls', () => {
    const usage = new CodeMapUsage();
    for (let i = 0; i < MAX_USAGE_SESSIONS + 5; i++) usage.record(call({ sessionId: `s${i}`, at: i }));
    usage.record(call({ sessionId: 's5', at: 9999 }));
    usage.record(call({ sessionId: 'extra', at: 10_000 }));
    const ids = usage.snapshot().map((s) => s.sessionId);
    expect(ids).toHaveLength(MAX_USAGE_SESSIONS);
    expect(ids[0]).toBe('extra');
    expect(ids).toContain('s5');
    expect(ids).not.toContain('s0');

    const busy = new CodeMapUsage();
    for (let i = 0; i < MAX_USAGE_EVENTS_PER_SESSION + 50; i++) busy.record(call({ at: i }));
    expect(busy.snapshot()[0]!.calls).toBe(MAX_USAGE_EVENTS_PER_SESSION + 50);
    // Range totals use the retained calls only.
    expect(busy.totals([{ key: 'all', terminalId: 't1', from: 0, to: 1e9 }])['all']!.calls).toBe(
      MAX_USAGE_EVENTS_PER_SESSION,
    );
  });

  it("totals a terminal's calls inside a time range, by key, and leaves out ranges without calls", () => {
    const usage = new CodeMapUsage();
    usage.record(call({ at: 1000 }));
    usage.record(call({ at: 2000, report: { stale: true }, result: text('xxxxxxxxxx') }));
    usage.record(call({ at: 9000, failed: true }));
    // Another MCP session of the same terminal (the agent was restarted) and another terminal altogether.
    usage.record(call({ sessionId: 'again', at: 2500, report: { notOk: true } }));
    usage.record(call({ sessionId: 'other', terminalId: 't2', at: 2000 }));
    expect(
      usage.totals([
        { key: 'first', terminalId: 't1', from: 0, to: 2600 },
        { key: 'inclusive', terminalId: 't1', from: 2000, to: 2000 },
        { key: 'late', terminalId: 't1', from: 8000, to: 10_000 },
        { key: 'none', terminalId: 't1', from: 3000, to: 8000 },
        { key: 'unknown', terminalId: 'nope', from: 0, to: 1e9 },
      ]),
    ).toEqual({
      first: { calls: 3, chars: 5 + 10 + 5, stale: 1, notOk: 1, errors: 0 },
      inclusive: { calls: 1, chars: 10, stale: 1, notOk: 0, errors: 0 },
      late: { calls: 1, chars: 5, stale: 0, notOk: 0, errors: 1 },
    });
    usage.clear();
    expect(usage.snapshot()).toEqual([]);
  });
});
