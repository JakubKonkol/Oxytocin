import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@shared/domain/terminal';
import { busyTerminals, describeQuit } from './quit-guard';

const t = (over: Partial<TerminalInfo>): TerminalInfo => ({
  id: 't',
  projectId: 'a',
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

describe('quit guard', () => {
  it('lists running processes and agents per project', () => {
    const terminals = [
      t({ id: '1' }),
      t({
        id: '2',
        kind: 'agent',
        title: 'Fix tests',
        agent: {
          agentId: 'claude-code',
          displayName: 'Claude Code',
          provider: 'anthropic',
          pid: 5,
          state: 'working',
          stateSource: 'claude-registry',
          since: 0,
        },
      }),
      t({ id: '3', projectId: 'b', kind: 'process', foreground: { pid: 9, name: 'npm', commandLine: 'npm run dev' } }),
      t({ id: '4', kind: 'process', state: 'exited', exitCode: 0 }),
    ];
    const busy = busyTerminals(terminals);
    expect(busy.map((x) => x.id)).toEqual(['2', '3']);
    const prompt = describeQuit(busy, (id) => ({ a: 'api', b: 'web' })[id]);
    expect(prompt.message).toBe(
      '2 terminals have running processes (Claude Code in ‘api’, npm run dev in ‘web’). Quit anyway?',
    );
    expect(prompt.detail).toContain('• Claude Code in ‘api’ — Fix tests');
    expect(prompt.detail).toContain('• npm run dev in ‘web’ — bash');
  });

  it('shortens long command lines and caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      t({
        id: String(i),
        kind: 'process',
        foreground: { pid: i, name: 'node', commandLine: `node ${'x'.repeat(80)}` },
      }),
    );
    const prompt = describeQuit(many, () => undefined);
    expect(prompt.message).toMatch(/^10 terminals have running processes \(node x+…, node x+……\)\. Quit anyway\?$/);
    expect(prompt.detail).toContain('…and 2 more');
  });
});
