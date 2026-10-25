import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@shared/domain/terminal';
import { useTerminalsStore } from '../../stores/terminals-store';
import { persistedTerminalsKey } from './persistence';

const terminal = (id: string, projectId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  projectId,
  profileId: 'bash',
  profileName: 'bash',
  title: 'bash',
  pid: 1,
  cwd: '/work',
  shellType: 'bash',
  kind: 'shell',
  state: 'running',
  createdAt: 0,
  envStale: false,
  bell: false,
  ...extra,
});

afterEach(() => useTerminalsStore.setState({ terminals: {} }));

describe('persistedTerminalsKey', () => {
  it('changes with what a saved workspace contains, not with live state or other projects', () => {
    useTerminalsStore.setState({ terminals: { a: terminal('a', 'p'), b: terminal('b', 'other') } });
    const key = persistedTerminalsKey('p');
    useTerminalsStore
      .getState()
      .upsert(terminal('a', 'p', { bell: true, lastCommand: { durationMs: 5, finishedAt: 9 } }));
    useTerminalsStore.getState().upsert(terminal('b', 'other', { cwd: '/elsewhere' }));
    expect(persistedTerminalsKey('p')).toBe(key);
    useTerminalsStore.getState().upsert(terminal('a', 'p', { cwd: '/work/src' }));
    expect(persistedTerminalsKey('p')).not.toBe(key);
  });
});
