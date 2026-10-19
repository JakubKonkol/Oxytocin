import { describe, expect, it, vi } from 'vitest';
import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { AgentLauncherService } from './agent-launcher';

function setup() {
  const terms: TerminalInfo[] = [];
  const agents: AgentInfoWithTerminal[] = [];
  const profile = { id: 'ai:claude', icon: 'agent-claude', command: 'claude --model opusplan' } as TerminalProfile;
  const create = vi.fn((projectId: string, profileId: string) => {
    const t = { id: `t${terms.length}`, projectId, profileId, state: 'running' } as TerminalInfo;
    terms.push(t);
    agents.push({ terminalId: t.id, projectId, state: 'idle' } as AgentInfoWithTerminal);
    return Promise.resolve(t);
  });
  const send = vi.fn(() => Promise.resolve({ ok: true as const }));
  const show = vi.fn();
  const service = new AgentLauncherService({
    profile: (id) => Promise.resolve(id === profile.id ? profile : undefined),
    terminals: (id) => terms.filter((t) => t.projectId === id),
    agents: () => agents,
    create,
    send,
    show,
  });
  return { service, create, send, show, terms, agents };
}

describe('AgentLauncherService', () => {
  it('starts a normal profile terminal with plan mode and preserves the custom command', async () => {
    const s = setup();
    expect(
      await s.service.launch({ projectId: 'p', launchId: 'ai:claude', planMode: true, prompt: 'Plan this' }),
    ).toEqual({ terminalId: 't0', reused: false, sent: true });
    expect(s.create).toHaveBeenCalledWith('p', 'ai:claude', {
      command: { head: 'claude --model opusplan', args: ['--permission-mode', 'plan'] },
    });
    expect(s.show).toHaveBeenCalledWith('t0', 'p');
    expect(s.send).toHaveBeenCalledWith('t0', 'Plan this');
  });
  it('adds Claude arguments and variables to a new session only', async () => {
    const s = setup();
    const request = {
      projectId: 'p',
      launchId: 'ai:claude',
      planMode: true,
      claudeArgs: ['--allow-dangerously-skip-permissions', '--settings', 'C:\\Users\\Jane Doe\\task.json'],
      env: { OXYTOCIN_TASK_ID: 'task-1' },
    };
    await s.service.launch(request);
    expect(s.create).toHaveBeenCalledWith('p', 'ai:claude', {
      command: {
        head: 'claude --model opusplan',
        args: [
          '--permission-mode',
          'plan',
          '--allow-dangerously-skip-permissions',
          '--settings',
          'C:\\Users\\Jane Doe\\task.json',
        ],
      },
      env: { OXYTOCIN_TASK_ID: 'task-1' },
    });
    // A reused session keeps its own command line and environment.
    expect((await s.service.launch(request)).reused).toBe(true);
    expect(s.create).toHaveBeenCalledTimes(1);
  });
  it('reuses an idle profile session and does not spawn or type over a busy agent', async () => {
    const s = setup();
    const request = { projectId: 'p', launchId: 'ai:claude', prompt: 'Do this' };
    await s.service.launch(request);
    expect((await s.service.launch(request)).reused).toBe(true);
    s.agents[0]!.state = 'working';
    const blocked = await s.service.launch(request);
    expect(blocked.error).toContain('not ready');
    expect(blocked).toMatchObject({
      sent: false,
      reused: true,
    });
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(2);
  });
  it('supports a fresh session and rejects a session from another project or profile', async () => {
    const s = setup();
    await s.service.launch({ projectId: 'p', launchId: 'ai:claude' });
    await s.service.launch({ projectId: 'p', launchId: 'ai:claude', reuse: false });
    expect(s.create).toHaveBeenCalledTimes(2);
    await expect(s.service.launch({ projectId: 'other', launchId: 'ai:claude', terminalId: 't0' })).rejects.toThrow(
      /no longer running/,
    );
    s.terms[0]!.profileId = 'ai:profile:other';
    await expect(s.service.launch({ projectId: 'p', launchId: 'ai:claude', terminalId: 't0' })).rejects.toThrow(
      /another agent profile/,
    );
    await expect(s.service.launch({ projectId: 'p', launchId: 'ai:missing' })).rejects.toThrow(/no longer available/);
  });
  it('serializes launches so double requests reuse the first terminal', async () => {
    const s = setup();
    await Promise.all([
      s.service.launch({ projectId: 'p', launchId: 'ai:claude' }),
      s.service.launch({ projectId: 'p', launchId: 'ai:claude' }),
    ]);
    expect(s.create).toHaveBeenCalledTimes(1);
  });
});
