import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptClaudeLine, claudeProjectDirs, parseClaudeLine } from './claude-jsonl';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const assistant = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    timestamp: '2026-09-26T10:00:00.000Z',
    sessionId: 's1',
    uuid: 'u1',
    requestId: 'req_1',
    cwd: '/p',
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage },
    ...extra,
  });

describe('Claude transcript parser', () => {
  it('maps usage fields', () => {
    const r = parseClaudeLine(
      assistant({
        input_tokens: 2,
        output_tokens: 391,
        cache_read_input_tokens: 24732,
        cache_creation_input_tokens: 17499,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 17499 },
        output_tokens_details: { thinking_tokens: 288 },
        server_tool_use: { web_search_requests: 1 },
        service_tier: 'standard',
        speed: 'fast',
        inference_geo: 'us',
      }),
      '/x/s1.jsonl',
    );
    expect(r).toEqual({
      id: 'claude:msg_1:req_1',
      ts: Date.parse('2026-09-26T10:00:00.000Z'),
      agent: 'claude-code',
      provider: 'anthropic',
      rawModel: 'claude-opus-5-5',
      sessionId: 's1',
      cwd: '/p',
      isSubagent: false,
      tokens: { input: 2, output: 391, cacheRead: 24732, cacheWrite5m: 0, cacheWrite1h: 17499, reasoning: 288 },
      extras: { speed: 'fast', serviceTier: 'standard', inferenceGeo: 'us', webSearchRequests: 1 },
      reportedCostUsd: null,
      source: 'claude-jsonl',
    });
  });

  it('handles older lines, sidechains, subagent files and missing ids', () => {
    const old = parseClaudeLine(
      assistant(
        { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 300 },
        { costUSD: 0.01, isSidechain: true },
      ),
      '/x/s1.jsonl',
    )!;
    expect(old.tokens).toMatchObject({ cacheWrite5m: 300, cacheWrite1h: 0 });
    expect(old.reportedCostUsd).toBe(0.01);
    expect(old.isSubagent).toBe(true);
    expect(parseClaudeLine(assistant({ output_tokens: 1 }), join('/x', 's1', 'subagents', 'a.jsonl'))!.isSubagent).toBe(
      true,
    );
    const noId = line({
      type: 'assistant',
      timestamp: '2026-09-26T10:00:00Z',
      uuid: 'u9',
      message: { model: 'm', usage: {} },
    });
    expect(parseClaudeLine(noId, '/x')!.id).toBe('claude:uuid:u9');
  });

  it('skips synthetic messages, user lines, broken JSON and lines without usage', () => {
    expect(
      parseClaudeLine(
        line({ type: 'assistant', timestamp: 't', message: { id: 'm', model: '<synthetic>', usage: {} } }),
        '/x',
      ),
    ).toBeNull();
    expect(parseClaudeLine(line({ type: 'user', message: { usage: {} } }), '/x')).toBeNull();
    expect(parseClaudeLine('{"usage": ', '/x')).toBeNull();
    expect(parseClaudeLine(line({ type: 'assistant', message: { id: 'm' } }), '/x')).toBeNull();
    expect(acceptClaudeLine(Buffer.from('{"type":"user","message":"hi"}'))).toBe(false);
    expect(acceptClaudeLine(Buffer.from('{"message":{"usage":{}}}'))).toBe(true);
  });

  it('finds configuration folders once each', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oxy-claude-'));
    try {
      await mkdir(join(home, '.claude', 'projects'), { recursive: true });
      await mkdir(join(home, 'custom', 'projects'), { recursive: true });
      const dirs = claudeProjectDirs(
        { CLAUDE_CONFIG_DIR: `${join(home, 'custom')}, ${join(home, '.claude')}` },
        [],
        home,
      );
      expect(dirs).toHaveLength(2);
      expect(dirs[0]).toMatch(/custom[\\/]projects$/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
