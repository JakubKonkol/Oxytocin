import { describe, expect, it } from 'vitest';
import { CumulativeTracker, parseOtlpMetrics } from './otlp';
import { claudeExport, kv, point } from './otlp-test-payloads';

describe('OTLP metrics', () => {
  it('maps Claude token and cost metrics to one record per session, model and time', () => {
    const batch = parseOtlpMetrics(
      claudeExport('s1', 't-1', { input: 10, output: 20, cacheRead: 300, cacheCreation: 40 }, 0.5),
      new CumulativeTracker(),
    );
    expect(batch.records).toEqual([
      expect.objectContaining({
        id: 'claude-otel:s1:1790445600000:claude-opus-5-5',
        ts: 1790445600000,
        agent: 'claude-code',
        source: 'claude-otel',
        tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite5m: 40, cacheWrite1h: 0, reasoning: 0 },
        reportedCostUsd: 0.5,
      }),
    ]);
    expect(batch.sessions).toEqual([
      { sessionId: 's1', agent: 'claude-code', terminalId: 't-1', projectId: 'p1', reportedCostUsd: 0.5 },
    ]);
  });

  it('turns cumulative Gemini sums into deltas with Google semantics', () => {
    const tracker = new CumulativeTracker();
    const gemini = (values: Record<string, number>, t: string) => ({
      resourceMetrics: [
        {
          resource: { attributes: [kv('session.id', 'g1')] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'gemini_cli.token.usage',
                  sum: {
                    aggregationTemporality: 2,
                    dataPoints: Object.entries(values).map(([type, v]) =>
                      point({ model: 'gemini-2.5-pro', type }, v, t),
                    ),
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const first = parseOtlpMetrics(
      gemini({ input: 1000, cache: 400, output: 50, thought: 10, tool: 5 }, '1000000000'),
      tracker,
    );
    expect(first.records[0]!.tokens).toMatchObject({ input: 605, cacheRead: 400, output: 60, reasoning: 10 });
    const second = parseOtlpMetrics(
      gemini({ input: 1500, cache: 400, output: 80, thought: 10, tool: 5 }, '2000000000'),
      tracker,
    );
    expect(second.records[0]!.tokens).toMatchObject({ input: 500, cacheRead: 0, output: 30, reasoning: 0 });
    expect(parseOtlpMetrics(gemini({ input: 1500 }, '3000000000'), tracker).records).toEqual([]);
  });

  it('ignores unrelated or malformed payloads', () => {
    expect(parseOtlpMetrics({}, new CumulativeTracker())).toEqual({ records: [], sessions: [] });
    expect(
      parseOtlpMetrics({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'x' }] }] }] }, new CumulativeTracker())
        .records,
    ).toEqual([]);
  });
});
