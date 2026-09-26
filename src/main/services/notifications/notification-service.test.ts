import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '@shared/domain/agent';
import { resolveSettings } from '@shared/domain/settings';
import type { TerminalInfo } from '@shared/domain/terminal';
import { Emitter } from '@shared/utils/emitter';
import { NotificationService } from './notification-service';

const base: TerminalInfo = {
  id: 't1',
  projectId: 'p',
  profileId: 'bash',
  profileName: 'bash',
  title: 'bash',
  pid: 1,
  cwd: '/',
  shellType: 'bash',
  kind: 'agent',
  state: 'running',
  createdAt: 0,
  envStale: false,
  bell: false,
};
const agent = (state: AgentInfo['state'], extra: Partial<AgentInfo> = {}): AgentInfo => ({
  agentId: 'claude-code',
  displayName: 'Claude Code',
  provider: 'anthropic',
  pid: 2,
  state,
  stateSource: 'claude-registry',
  since: 0,
  ...extra,
});

function setup(settings: Record<string, unknown> = {}, focused = false) {
  let now = 0;
  const updated = new Emitter<TerminalInfo>();
  const removed = new Emitter<string>();
  const toast = vi.fn();
  const osNotify = vi.fn();
  const flash = vi.fn();
  const reveal = vi.fn();
  new NotificationService({
    terminals: { get: () => undefined, onDidUpdate: updated.event, onDidRemove: removed.event },
    settings: () => resolveSettings(settings, 'linux').settings,
    projectName: () => 'api',
    toast,
    window: { isFocused: () => focused, flash },
    osNotify,
    reveal,
    now: () => now,
  });
  return {
    fire: (info: Partial<TerminalInfo>) => updated.fire({ ...base, ...info }),
    advance: (ms: number) => (now += ms),
    toast,
    osNotify,
    flash,
    reveal,
  };
}

describe('NotificationService', () => {
  it('announces a waiting agent with a toast, an OS notification and a taskbar flash', () => {
    const s = setup();
    s.fire({ agent: agent('working') });
    s.fire({ agent: agent('waiting', { waitingFor: 'permission' }) });
    expect(s.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'warning',
        message: 'Claude Code is waiting for tool permission',
        description: 'api · bash',
        target: { projectId: 'p', terminalId: 't1' },
        onlyIfHidden: true,
      }),
    );
    expect(s.flash).toHaveBeenCalledWith(true);
    expect(s.osNotify).toHaveBeenCalledTimes(1);
    (s.osNotify.mock.calls[0]![0] as { onClick: () => void }).onClick();
    expect(s.reveal).toHaveBeenCalledWith({ projectId: 'p', terminalId: 't1' });
    // Staying in "waiting" does not notify again.
    s.fire({ agent: agent('waiting') });
    expect(s.toast).toHaveBeenCalledTimes(1);
  });

  it('respects focus, do-not-disturb and the per-event settings', () => {
    const focused = setup({}, true);
    focused.fire({ agent: agent('working') });
    focused.fire({ agent: agent('waiting') });
    expect(focused.toast).toHaveBeenCalledTimes(1);
    expect(focused.osNotify).not.toHaveBeenCalled();
    expect(focused.flash).not.toHaveBeenCalled();

    const dnd = setup({ 'notifications.doNotDisturb': true });
    dnd.fire({ agent: agent('working') });
    dnd.fire({ agent: agent('waiting') });
    expect(dnd.osNotify).not.toHaveBeenCalled();
    expect(dnd.flash).toHaveBeenCalledWith(true);

    const off = setup({ 'notifications.agentWaiting': false });
    off.fire({ agent: agent('working') });
    off.fire({ agent: agent('waiting') });
    expect(off.toast).not.toHaveBeenCalled();
  });

  it('reports finished agents only after long enough work', () => {
    const s = setup();
    s.fire({ agent: agent('working') });
    s.advance(10_000);
    s.fire({ agent: agent('idle') });
    expect(s.toast).not.toHaveBeenCalled();
    s.fire({ agent: agent('working') });
    s.advance(31_000);
    s.fire({ agent: agent('idle') });
    expect(s.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', message: 'Claude Code finished' }));
    expect(s.osNotify).toHaveBeenCalledTimes(1);
  });

  it('reports error exits in-app only', () => {
    const s = setup();
    s.fire({ kind: 'process' });
    s.fire({ kind: 'process', state: 'exited', exitCode: 2 });
    expect(s.toast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', message: 'Process exited with code 2' }),
    );
    expect(s.osNotify).not.toHaveBeenCalled();
    s.fire({ state: 'exited', exitCode: 0 });
    expect(s.toast).toHaveBeenCalledTimes(1);
  });
});
