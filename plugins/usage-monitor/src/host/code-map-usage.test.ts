import { describe, expect, it, vi } from 'vitest';
import { ATTRIBUTION_SLACK_MS, CODE_MAP_USAGE_COMMAND, withCodeMapUsage } from './code-map-usage';

const row = (
  sessionId: string,
  terminalId: string | null,
  firstEventAt: number | null,
  lastEventAt: number | null,
) => ({
  sessionId,
  terminalId,
  firstEventAt,
  lastEventAt,
  cost: 1,
});
const figure = { calls: 4, chars: 900, stale: 1, notOk: 1, errors: 0 };
const zeros = { calls: 0, chars: 0, stale: 0, notOk: 0, errors: 0 };

describe('withCodeMapUsage', () => {
  it("asks for the terminal's calls between the session's first and last event, with slack, in one request", async () => {
    const execute = vi.fn(() => Promise.resolve({ a: figure }));
    const rows = await withCodeMapUsage(
      [row('a', 't1', 1_000_000, 2_000_000), row('b', 't2', 5_000_000, 6_000_000), row('c', null, 1, 2)],
      execute,
      0,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(CODE_MAP_USAGE_COMMAND, {
      ranges: [
        { key: 'a', terminalId: 't1', from: 1_000_000 - ATTRIBUTION_SLACK_MS, to: 2_000_000 + ATTRIBUTION_SLACK_MS },
        { key: 'b', terminalId: 't2', from: 5_000_000 - ATTRIBUTION_SLACK_MS, to: 6_000_000 + ATTRIBUTION_SLACK_MS },
      ],
    });
    // Existing fields are kept; a session in a terminal that made no call counted zero; one outside a terminal is unknown.
    expect(rows).toEqual([
      { ...row('a', 't1', 1_000_000, 2_000_000), codeMap: figure },
      { ...row('b', 't2', 5_000_000, 6_000_000), codeMap: zeros },
      { ...row('c', null, 1, 2), codeMap: null },
    ]);
  });

  it('leaves the figure unknown for sessions that ended before Oxytocin started counting', async () => {
    const rows = await withCodeMapUsage(
      [row('old', 't1', 100, 200), row('running', 't1', 100, 5000)],
      () => Promise.resolve({}),
      1000,
    );
    expect(rows.map((r) => r.codeMap)).toEqual([null, zeros]);
  });

  it('asks nothing without a terminal and ignores an app that cannot answer or answers nonsense', async () => {
    const execute = vi.fn(() => Promise.resolve({}));
    expect((await withCodeMapUsage([row('c', null, 1, 2)], execute, 0))[0]!.codeMap).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    const failing = () => Promise.reject(new Error('Unknown command'));
    expect((await withCodeMapUsage([row('a', 't1', 1, 2)], failing, 0))[0]!.codeMap).toBeNull();
    const nonsense = () => Promise.resolve({ a: { calls: 'many' }, constructor: figure });
    expect((await withCodeMapUsage([row('a', 't1', 1, 2)], nonsense, 0))[0]!.codeMap).toEqual(zeros);
    expect((await withCodeMapUsage([row('a', 't1', 1, 2)], () => Promise.resolve(null), 0))[0]!.codeMap).toEqual(zeros);
  });

  it('asks for at most 200 sessions per request', async () => {
    const execute = vi.fn((_id: string, _arg: unknown) => Promise.resolve({}));
    const many = Array.from({ length: 250 }, (_, i) => row(`s${i}`, 't1', 1, 2));
    const rows = await withCodeMapUsage(many, execute, 0);
    expect((execute.mock.calls[0]![1] as { ranges: unknown[] }).ranges).toHaveLength(200);
    expect(rows).toHaveLength(250);
    expect(rows[249]!.codeMap).toBeNull();
  });
});
