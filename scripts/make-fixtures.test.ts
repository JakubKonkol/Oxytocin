import { describe, expect, it } from 'vitest';
import { anonymize } from './make-fixtures';

describe('make-fixtures', () => {
  it('keeps Claude usage metadata and drops content and paths', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      sessionId: 's',
      uuid: 'u',
      cwd: '/home/me/secret-project',
      gitBranch: 'feature/secret',
      requestId: 'r',
      message: {
        id: 'm',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'private answer' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const out = anonymize('claude', `${line}\n{"type":"attachment","attachment":"x"}\n`, { cwd: '/fixture/proj' });
    expect(out).not.toMatch(/private|secret/);
    expect(JSON.parse(out)).toEqual({
      type: 'assistant',
      timestamp: 't',
      sessionId: 's',
      uuid: 'u',
      requestId: 'r',
      cwd: '/fixture/proj',
      message: {
        id: 'm',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: 'text' }],
      },
    });
  });

  it('keeps Codex token counts and Gemini token records only, up to a limit', () => {
    const codex = [
      { timestamp: 't', type: 'session_meta', payload: { id: 's', cwd: '/secret', instructions: 'private' } },
      { timestamp: 't', type: 'response_item', payload: { type: 'message', content: 'private' } },
      { timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {} } } },
      { timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: null } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
    const out = anonymize('codex', codex, { cwd: '/fixture/proj', limit: 1 });
    expect(out).not.toMatch(/private|secret/);
    expect(out.trim().split('\n')).toHaveLength(2);

    const gemini = [
      { sessionId: 's', projectHash: 'h', startTime: 't', directories: ['/secret'] },
      {
        id: 'm',
        type: 'gemini',
        model: 'gemini-2.5-pro',
        content: 'private',
        thoughts: ['private'],
        tokens: { input: 1 },
      },
      { $set: { memoryScratchpad: 'private' } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
    const g = anonymize('gemini', gemini, { cwd: '/fixture/proj' });
    expect(g).not.toMatch(/private|secret/);
    expect(
      g
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { sessionId: 's', projectHash: 'h', startTime: 't' },
      { id: 'm', type: 'gemini', model: 'gemini-2.5-pro', tokens: { input: 1 }, content: '' },
    ]);
  });
});
