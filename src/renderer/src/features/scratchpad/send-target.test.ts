import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@shared/domain/terminal';
import { agentTargets, resolveAgentTarget, sanitizeForPaste } from './send-target';

function term(id: string, patch: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    projectId: 'p1',
    profileId: 'agent:claude',
    profileName: 'Claude Code',
    title: 'Claude Code',
    pid: 1,
    cwd: '/',
    shellType: 'bash',
    kind: 'agent',
    state: 'running',
    createdAt: Number(id.replace(/\D/g, '')) || 0,
    envStale: false,
    bell: false,
    ...patch,
  };
}

const projects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta' },
];
const agent = {
  agentId: 'codex',
  displayName: 'Codex CLI',
  provider: 'openai',
  pid: 2,
  state: 'idle',
  stateSource: 'none',
  since: 0,
} as const;

describe('agentTargets', () => {
  it('keeps running agents only, active project first, labels others with the project name', () => {
    const terminals = {
      t1: term('t1', { projectId: 'p2' }),
      t2: term('t2'),
      t3: term('t3', { kind: 'shell', title: 'bash', profileName: 'bash' }),
      t4: term('t4', { kind: 'shell', title: 'bash', profileName: 'bash', agent }),
      t5: term('t5', { state: 'exited' }),
      t6: term('t6', { projectId: 'gone' }),
    };
    expect(agentTargets(terminals, projects, 'p1')).toEqual([
      { terminalId: 't2', projectId: 'p1', label: 'Claude Code', inActiveProject: true },
      { terminalId: 't4', projectId: 'p1', label: 'Codex CLI', inActiveProject: true },
      { terminalId: 't1', projectId: 'p2', label: 'Beta · Claude Code', inActiveProject: false },
    ]);
  });
});

describe('resolveAgentTarget', () => {
  const targets = agentTargets({ t1: term('t1', { projectId: 'p2' }), t2: term('t2') }, projects, 'p1');

  it('prefers the chosen agent, then the last focused one', () => {
    expect(resolveAgentTarget(targets, 't1', 't2')?.terminalId).toBe('t1');
    expect(resolveAgentTarget(targets, 'missing', 't1')?.terminalId).toBe('t1');
  });

  it('falls back to the only agent of the active project', () => {
    expect(resolveAgentTarget(targets, null, null)?.terminalId).toBe('t2');
  });

  it('falls back to the only agent overall', () => {
    const one = agentTargets({ t1: term('t1', { projectId: 'p2' }) }, projects, 'p1');
    expect(resolveAgentTarget(one, null, null)?.terminalId).toBe('t1');
  });

  it('asks when several agents are equally likely', () => {
    const two = agentTargets({ t1: term('t1'), t2: term('t2') }, projects, 'p1');
    expect(resolveAgentTarget(two, null, null)).toBeNull();
    expect(resolveAgentTarget([], null, null)).toBeNull();
  });
});

describe('sanitizeForPaste', () => {
  it('removes control characters that could end a bracketed paste or inject keys', () => {
    expect(sanitizeForPaste('a\x1b[201~rm -rf ~\r\nb')).toBe('a[201~rm -rf ~\nb');
    expect(sanitizeForPaste('tab\there\r\nnext\x00\x07\x9b')).toBe('tab\there\nnext');
    expect(sanitizeForPaste('zażółć — ✓')).toBe('zażółć — ✓');
  });
});
