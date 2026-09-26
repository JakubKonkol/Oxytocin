import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '@shared/domain/agent';
import type { TerminalInfo } from '@shared/domain/terminal';
import { Emitter } from '@shared/utils/emitter';
import { deriveActivity, runtimeStatus } from './activity';
import { ActivityService } from './activity-service';

const agent = (state: AgentInfo['state']): AgentInfo => ({
  agentId: 'claude-code',
  displayName: 'Claude Code',
  provider: 'anthropic',
  pid: 2,
  state,
  stateSource: 'claude-registry',
  since: 0,
});

let n = 0;
const t = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: `t${++n}`,
  projectId: 'p',
  profileId: 'bash',
  profileName: 'bash',
  title: 'bash',
  pid: 1,
  cwd: '/',
  shellType: 'bash',
  kind: 'shell',
  state: 'running',
  createdAt: 0,
  envStale: false,
  bell: false,
  ...over,
});

describe('deriveActivity', () => {
  const none = new Set<string>();
  it('follows the priority attention > error > agent-working > running > idle', () => {
    expect(deriveActivity([], none)).toBe('none');
    expect(deriveActivity([t()], none)).toBe('idle');
    expect(deriveActivity([t(), t({ kind: 'process' })], none)).toBe('running');
    expect(deriveActivity([t({ kind: 'agent', agent: agent('unknown') })], none)).toBe('running');
    expect(deriveActivity([t({ kind: 'agent', agent: agent('idle') })], none)).toBe('idle');
    expect(deriveActivity([t({ kind: 'process' }), t({ kind: 'agent', agent: agent('working') })], none)).toBe(
      'agent-working',
    );
    const failed = t({ state: 'exited', exitCode: 3 });
    expect(deriveActivity([t({ kind: 'agent', agent: agent('working') }), failed], none)).toBe('error');
    expect(deriveActivity([failed, t({ kind: 'agent', agent: agent('waiting') })], none)).toBe('attention');
  });

  it('forgets errors the user has seen and ignores clean exits', () => {
    const failed = t({ state: 'exited', exitCode: 1 });
    expect(deriveActivity([failed], new Set([failed.id]))).toBe('idle');
    expect(deriveActivity([t({ state: 'exited', exitCode: 0 })], new Set())).toBe('idle');
  });

  it('counts terminals, processes and agents', () => {
    const failed = t({ state: 'exited', exitCode: 2 });
    const status = runtimeStatus(
      'p',
      [
        t({ kind: 'process' }),
        t({ kind: 'agent', agent: agent('waiting') }),
        t({ kind: 'agent', agent: agent('working') }),
        failed,
      ],
      new Set(),
      new Map([[failed.id, 5]]),
    );
    expect(status).toMatchObject({
      activity: 'attention',
      terminals: 4,
      runningProcesses: 1,
      agents: { working: 1, waiting: 1, idle: 0 },
      unseenError: { terminalId: failed.id, exitCode: 2, at: 5 },
    });
  });
});

describe('ActivityService', () => {
  it('emits only changed projects, debounced', () => {
    vi.useFakeTimers();
    try {
      const infos = new Map<string, TerminalInfo>();
      const updated = new Emitter<TerminalInfo>();
      const removed = new Emitter<string>();
      const service = new ActivityService(
        { list: () => [...infos.values()], onDidUpdate: updated.event, onDidRemove: removed.event },
        () => ['p', 'q'],
      );
      const events: string[][] = [];
      service.onDidChange((list) => events.push(list.map((s) => `${s.projectId}:${s.activity}`)));
      service.flush();
      expect(events).toEqual([['p:none', 'q:none']]);

      const a = t({ projectId: 'p' });
      infos.set(a.id, a);
      updated.fire(a);
      const b = { ...a, kind: 'process' as const };
      infos.set(a.id, b);
      updated.fire(b);
      vi.advanceTimersByTime(100);
      expect(events.at(-1)).toEqual(['p:running']);

      const exited = { ...b, state: 'exited' as const, exitCode: 1 };
      infos.set(a.id, exited);
      updated.fire(exited);
      vi.advanceTimersByTime(100);
      expect(events.at(-1)).toEqual(['p:error']);
      service.markSeen(a.id);
      vi.advanceTimersByTime(100);
      expect(events.at(-1)).toEqual(['p:idle']);
      expect(events).toHaveLength(4);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
