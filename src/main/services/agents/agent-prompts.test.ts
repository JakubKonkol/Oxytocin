import { describe, expect, it, vi } from 'vitest';
import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { AgentPromptService } from './agent-prompts';

function setup(state: AgentInfoWithTerminal['state'], screen = '› ') {
  const agents = new Emitter<AgentInfoWithTerminal[]>();
  let agent: AgentInfoWithTerminal = {
    terminalId: 't1',
    projectId: 'p',
    agentId: 'claude-code',
    displayName: 'Claude Code',
    provider: 'anthropic',
    pid: 1,
    state,
    stateSource: 'claude-registry',
    since: 0,
  };
  const paste = vi.fn((_id: string, _text: string, _submit: boolean) => {
    // The agent starts working once the prompt is submitted.
    agent = { ...agent, state: 'working' };
    agents.fire([agent]);
    return Promise.resolve();
  });
  const service = new AgentPromptService({
    agents: { list: () => [agent], onDidUpdate: agents.event },
    pty: {
      paste,
      write: vi.fn(() => Promise.resolve()),
      text: () => Promise.resolve(screen),
      onActivity: () => toDisposable(() => undefined),
    },
    platform: 'linux',
    confirmMs: 200,
  });
  return { service, paste };
}

describe('AgentPromptService', () => {
  it('types the prompt into an idle agent and confirms it started', async () => {
    const { service, paste } = setup('idle');
    expect(await service.send('t1', '  Continue the implementation.  ')).toEqual({ ok: true });
    expect(paste).toHaveBeenCalledWith('t1', 'Continue the implementation.', true);
  });

  it('refuses busy agents, open questions, slash commands and terminals without an agent', async () => {
    const error = async (state: AgentInfoWithTerminal['state'], text: string, screen?: string, id = 't1') => {
      const result = await setup(state, screen).service.send(id, text);
      return result.ok ? null : result.error;
    };
    expect(await error('working', 'x')).toMatch(/working/);
    expect(await error('idle', 'x', 'Do you trust the files in this folder?')).toMatch(/question/);
    expect(await error('idle', '/clear')).toMatch(/slash commands/);
    expect(await error('idle', 'x', undefined, 't2')).toMatch(/No AI agent/);
    expect(await error('idle', '   ')).toMatch(/empty/);
  });
});
