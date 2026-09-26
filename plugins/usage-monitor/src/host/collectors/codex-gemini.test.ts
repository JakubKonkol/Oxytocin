import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectHashes } from '../attribution';
import { isLimit, type UsageRecord } from '../model';
import { codexDedupeKey, isCodexRollout, parseCodexLine, type CodexState } from './codex-rollout';
import { isGeminiChat, parseGeminiDocument, parseGeminiLine, type GeminiState } from './gemini-chats';

const j = (o: unknown) => JSON.stringify(o);
const usage = (input: number, cached: number, output: number, reasoning: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const tokenCount = (ts: string, total: object, last?: object, rateLimits?: object) =>
  j({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, last_token_usage: last ?? total },
      rate_limits: rateLimits,
    },
  });

describe('Codex rollout parser', () => {
  it('turns cumulative totals into deltas, skips duplicates and handles resets', () => {
    const state: CodexState = {};
    expect(
      parseCodexLine(
        j({ timestamp: '2026-09-26T10:00:00Z', type: 'session_meta', payload: { id: 's', cwd: '/p' } }),
        state,
        'f',
      ),
    ).toEqual([]);
    parseCodexLine(
      j({ timestamp: '2026-09-26T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-5' } }),
      state,
      'f',
    );
    const first = parseCodexLine(
      tokenCount('2026-09-26T10:00:02Z', usage(100, 40, 10, 3)),
      state,
      'f',
    ) as UsageRecord[];
    expect(first).toEqual([
      expect.objectContaining({
        id: 'codex:s:110',
        rawModel: 'gpt-5',
        cwd: '/p',
        sessionStartedAt: Date.parse('2026-09-26T10:00:00Z'),
        tokens: { input: 60, cacheRead: 40, output: 10, reasoning: 3, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
    ]);
    expect(parseCodexLine(tokenCount('2026-09-26T10:00:03Z', usage(100, 40, 10, 3)), state, 'f')).toEqual([]);
    const second = parseCodexLine(
      tokenCount('2026-09-26T10:00:04Z', usage(300, 140, 30, 5)),
      state,
      'f',
    ) as UsageRecord[];
    expect(second[0]!.tokens).toMatchObject({ input: 100, cacheRead: 100, output: 20, reasoning: 2 });
    const reset = parseCodexLine(
      tokenCount('2026-09-26T10:00:05Z', usage(50, 0, 5, 0), usage(50, 0, 5, 0)),
      state,
      'f',
    ) as UsageRecord[];
    expect(reset[0]).toMatchObject({ id: 'codex:s:55', tokens: { input: 50, output: 5 } });
  });

  it('reports rate limits (absolute or relative reset times) and survives unknown models', () => {
    const state: CodexState = {};
    const items = parseCodexLine(
      j({
        timestamp: '2026-09-26T10:00:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: {
            primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1790467200 },
            secondary: { used_percent: 40, window_minutes: 10080, resets_in_seconds: 60 },
          },
        },
      }),
      state,
      'file-1',
    );
    expect(items.filter(isLimit)).toEqual([
      {
        kind: 'limit',
        agent: 'codex',
        window: 'primary',
        usedPercent: 12.5,
        windowMinutes: 300,
        resetsAt: 1790467200000,
        observedAt: Date.parse('2026-09-26T10:00:00Z'),
      },
      {
        kind: 'limit',
        agent: 'codex',
        window: 'secondary',
        usedPercent: 40,
        windowMinutes: 10080,
        resetsAt: Date.parse('2026-09-26T10:01:00Z'),
        observedAt: Date.parse('2026-09-26T10:00:00Z'),
      },
    ]);
    const noModel = parseCodexLine(
      tokenCount('2026-09-26T10:00:02Z', usage(10, 0, 1, 0)),
      state,
      'file-1',
    ) as UsageRecord[];
    expect(noModel[0]).toMatchObject({ rawModel: 'unknown', sessionId: 'file-1' });
  });

  it('recognizes rollouts and de-duplicates archived copies', () => {
    expect(isCodexRollout('/h/.codex/sessions/2026/09/26/rollout-2026-09-26T10-00-00-x.jsonl')).toBe(true);
    expect(isCodexRollout('/h/.codex/sessions/2026/09/26/other.jsonl')).toBe(false);
    expect(codexDedupeKey('/h/.codex/sessions/2026/09/26/rollout-a.jsonl')).toBe(
      codexDedupeKey('C:\\h\\.codex\\archived_sessions\\2026\\09\\26\\rollout-a.jsonl'),
    );
  });
});

describe('Gemini chat parser', () => {
  const tokens = { input: 12000, output: 600, cached: 5000, thoughts: 400, tool: 100, total: 13100 };
  it('maps tokens with Google semantics and keeps the last version of a message', () => {
    const state: GeminiState = {};
    parseGeminiLine(
      j({ sessionId: 'g', projectHash: 'h', startTime: '2026-09-26T10:00:00Z', kind: 'main' }),
      state,
      'f',
    );
    expect(
      parseGeminiLine(
        j({ id: 'm1', type: 'gemini', timestamp: '2026-09-26T10:00:05Z', model: 'gemini-2.5-pro', tokens: null }),
        state,
        'f',
      ),
    ).toEqual([]);
    expect(
      parseGeminiLine(
        j({ id: 'm1', type: 'gemini', timestamp: '2026-09-26T10:00:05Z', model: 'gemini-2.5-pro', tokens }),
        state,
        'f',
      ),
    ).toEqual([
      expect.objectContaining({
        id: 'gemini:g:m1',
        agent: 'gemini-cli',
        projectHash: 'h',
        isSubagent: false,
        sessionStartedAt: Date.parse('2026-09-26T10:00:00Z'),
        tokens: { input: 7100, cacheRead: 5000, output: 1000, reasoning: 400, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
    ]);
    expect(parseGeminiLine(j({ id: 'u1', type: 'user', timestamp: 't', content: 'x' }), state, 'f')).toEqual([]);
    expect(parseGeminiLine(j({ $set: { lastUpdated: 't' } }), state, 'f')).toEqual([]);
    const checkpoint = parseGeminiLine(
      j({
        $set: {
          messages: [
            { id: 'm2', type: 'gemini', timestamp: '2026-09-26T10:01:00Z', model: 'gemini-2.5-flash', tokens },
          ],
        },
      }),
      state,
      'f',
    );
    expect(checkpoint).toHaveLength(1);
  });

  it('reads legacy documents and recognizes chat files', () => {
    const doc = parseGeminiDocument(
      j({
        sessionId: 'old',
        projectHash: 'h',
        kind: 'subagent',
        messages: [{ id: 'm', type: 'gemini', timestamp: '2026-09-26T10:00:00Z', model: 'x', tokens }],
      }),
      'f',
    );
    expect(doc[0]).toMatchObject({ id: 'gemini:old:m', isSubagent: true });
    expect(isGeminiChat('/h/.gemini/tmp/p/chats/session-a.jsonl')).toBe(true);
    expect(isGeminiChat('/h/.gemini/tmp/p/chats/session-a.json')).toBe(true);
    expect(isGeminiChat('/h/.gemini/tmp/p/chats/session-a.jsonl.tmp-12')).toBe(false);
    expect(isGeminiChat('/h/.gemini/tmp/p/logs.json')).toBe(false);
  });

  it('computes the project hash variants', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(projectHashes('/fixture/proj')).toContain(sha('/fixture/proj'));
    expect(projectHashes('C:\\work\\api\\')).toEqual(
      expect.arrayContaining([sha('C:\\work\\api'), sha('c:\\work\\api')]),
    );
  });
});
