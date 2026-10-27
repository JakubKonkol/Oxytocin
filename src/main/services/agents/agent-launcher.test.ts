import { describe, expect, it, vi } from 'vitest';
import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import type { ShellKind } from '@shared/utils/shell-command';
import { AgentLauncherService, type NewSessionLaunch, startupPromptArgs } from './agent-launcher';

function setup(shell: ShellKind = 'bash') {
  const terms: TerminalInfo[] = [];
  const agents: AgentInfoWithTerminal[] = [];
  const profiles = [
    { id: 'ai:claude', icon: 'agent-claude', command: 'claude --model opusplan' },
    { id: 'ai:codex', icon: 'agent-codex', command: 'codex' },
    { id: 'ai:aider', icon: 'agent-aider', command: 'aider' },
  ] as TerminalProfile[];
  /** The command line of each new session, as its shell receives it ({ head, args }). */
  const commands: ({ head: string; args: string[] } | undefined)[] = [];
  const create = vi.fn((projectId: string, profileId: string, launch?: NewSessionLaunch) => {
    commands.push(launch?.command?.(shell));
    const t = { id: `t${terms.length}`, projectId, profileId, state: 'running' } as TerminalInfo;
    terms.push(t);
    agents.push({ terminalId: t.id, projectId, state: 'idle' } as AgentInfoWithTerminal);
    return Promise.resolve(t);
  });
  const send = vi.fn(() => Promise.resolve({ ok: true as const }));
  const show = vi.fn();
  const service = new AgentLauncherService({
    profile: (id) => Promise.resolve(profiles.find((p) => p.id === id)),
    terminals: (id) => terms.filter((t) => t.projectId === id),
    agents: () => agents,
    create,
    send,
    show,
  });
  return { service, create, send, show, terms, agents, commands, profiles };
}

describe('AgentLauncherService', () => {
  it('starts a new session with its prompt on the command line, in plan mode, with the custom command', async () => {
    const s = setup();
    expect(
      await s.service.launch({ projectId: 'p', launchId: 'ai:claude', planMode: true, prompt: 'Plan this' }),
    ).toEqual({ terminalId: 't0', reused: false, sent: true });
    expect(s.commands[0]).toEqual({
      head: 'claude --model opusplan',
      args: ['Plan this', '--permission-mode', 'plan'],
    });
    expect(s.show).toHaveBeenCalledWith('t0', 'p');
    // Nothing is typed: the agent starts with the prompt.
    expect(s.send).not.toHaveBeenCalled();
  });
  it('types a prompt the command line cannot carry once the new session is ready', async () => {
    const s = setup();
    expect(await s.service.launch({ projectId: 'p', launchId: 'ai:claude', prompt: 'Line one\nLine two' })).toEqual({
      terminalId: 't0',
      reused: false,
      sent: true,
    });
    expect(s.commands[0]).toEqual({ head: 'claude --model opusplan', args: [] });
    expect(s.send).toHaveBeenCalledWith('t0', 'Line one\nLine two');
    // CLIs without a startup prompt start with their configured command.
    await s.service.launch({ projectId: 'p', launchId: 'ai:aider', prompt: 'Fix it' });
    expect(s.commands[1]).toBeUndefined();
    expect(s.send).toHaveBeenLastCalledWith('t1', 'Fix it');
  });
  it('passes Codex its prompt and extra directories', async () => {
    const s = setup();
    await s.service.launch({ projectId: 'p', launchId: 'ai:codex', prompt: 'Implement it', addDirs: ['/data/task'] });
    expect(s.commands[0]).toEqual({ head: 'codex', args: ['Implement it', '--add-dir', '/data/task'] });
    expect(s.send).not.toHaveBeenCalled();
  });
  it('never puts the prompt where an option that takes several values would read it as one more value', async () => {
    const s = setup();
    await s.service.launch({
      projectId: 'p',
      launchId: 'ai:claude',
      planMode: true,
      prompt: 'Plan it',
      claudeArgs: ['--settings', '/data/task/claude-settings.json'],
    });
    expect(s.commands[0]!.args[0]).toBe('Plan it');
    expect(s.send).not.toHaveBeenCalled();
  });
  it('types the prompt of a Claude session started with extra directories once it is ready', async () => {
    const s = setup();
    // Claude Code's --add-dir keeps a startup prompt from being submitted (anthropics/claude-code#92930).
    expect(
      await s.service.launch({ projectId: 'p', launchId: 'ai:claude', prompt: 'Review it', addDirs: ['/data/task'] }),
    ).toEqual({ terminalId: 't0', reused: false, sent: true });
    expect(s.commands[0]).toEqual({ head: 'claude --model opusplan', args: ['--add-dir', '/data/task'] });
    expect(s.send).toHaveBeenCalledWith('t0', 'Review it');
  });
  it('types the prompt when the configured Claude command ends with an option that takes several values', async () => {
    const s = setup();
    for (const command of ['claude --add-dir ../shared', 'claude --allowedTools Read Grep', 'claude --add-dir=../x'])
      s.profiles.push({ id: `ai:${command}`, icon: 'agent-claude', command } as TerminalProfile);
    for (const [i, command] of ['claude --add-dir ../shared', 'claude --allowedTools Read Grep'].entries()) {
      await s.service.launch({ projectId: 'p', launchId: `ai:${command}`, prompt: 'Plan it' });
      expect(s.commands[i]).toBeUndefined();
      expect(s.send).toHaveBeenLastCalledWith(`t${i}`, 'Plan it');
    }
    await s.service.launch({ projectId: 'p', launchId: 'ai:claude --add-dir=../x', prompt: 'Plan it' });
    expect(s.send).toHaveBeenCalledTimes(3);
    // A similar-looking option is not one of them.
    s.profiles.push({ id: 'ai:tools', icon: 'agent-claude', command: 'claude --tools-help' } as TerminalProfile);
    await s.service.launch({ projectId: 'p', launchId: 'ai:tools', prompt: 'Plan it' });
    expect(s.commands.at(-1)).toEqual({ head: 'claude --tools-help', args: ['Plan it'] });
  });
  it('never puts what cmd.exe would expand on its command line', async () => {
    const s = setup('cmd');
    await s.service.launch({ projectId: 'p', launchId: 'ai:codex', prompt: 'Use 100% of %PATH%' });
    expect(s.commands[0]).toEqual({ head: 'codex', args: [] });
    expect(s.send).toHaveBeenCalledWith('t0', 'Use 100% of %PATH%');
    expect(startupPromptArgs('gemini', 'Plan it', 'pwsh')).toEqual(['--prompt-interactive', 'Plan it']);
    expect(startupPromptArgs('claude', 'x'.repeat(2001), 'bash')).toBeUndefined();
    expect(startupPromptArgs('claude', 'tab\there', 'bash')).toBeUndefined();
  });
  it('adds Claude arguments and variables to a new session only', async () => {
    const s = setup();
    const request = {
      projectId: 'p',
      launchId: 'ai:claude',
      planMode: true,
      claudeArgs: ['--allow-dangerously-skip-permissions', '--settings', 'C:\\Users\\Jane Doe\\task.json'],
      addDirs: ['C:\\Users\\Jane Doe\\task'],
      env: { OXYTOCIN_TASK_ID: 'task-1' },
    };
    await s.service.launch(request);
    expect(s.commands[0]).toEqual({
      head: 'claude --model opusplan',
      args: [
        '--permission-mode',
        'plan',
        '--allow-dangerously-skip-permissions',
        '--settings',
        'C:\\Users\\Jane Doe\\task.json',
        '--add-dir',
        'C:\\Users\\Jane Doe\\task',
      ],
    });
    expect(s.create.mock.calls[0]![2]).toMatchObject({ env: { OXYTOCIN_TASK_ID: 'task-1' } });
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
    // The new session got the prompt on its command line; only the reused one had it typed.
    expect(s.send).toHaveBeenCalledTimes(1);
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
