import { describe, expect, it } from 'vitest';
import { resumeInfo } from './agent-resume';

describe('resumeInfo', () => {
  it('builds the resume command of known agents', () => {
    expect(resumeInfo('claude-code', '8f3a-12')).toEqual({
      agentId: 'claude-code',
      sessionId: '8f3a-12',
      agentName: 'Claude Code',
      command: 'claude --resume 8f3a-12',
    });
    expect(resumeInfo('codex', 'abc')?.command).toBe('codex resume abc');
    expect(resumeInfo('gemini-cli', 'abc')?.command).toBe('gemini --resume abc');
  });

  it('refuses unknown agents, missing ids and ids that would need shell quoting', () => {
    expect(resumeInfo('aider', 'abc')).toBeNull();
    expect(resumeInfo('claude-code', undefined)).toBeNull();
    for (const id of ['a b', 'x;rm -rf /', '$(id)', '-flag', "a'b", ''])
      expect(resumeInfo('claude-code', id)).toBeNull();
  });
});
