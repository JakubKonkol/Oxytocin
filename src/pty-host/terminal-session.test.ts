import type { IPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import type { PtyToRenderer } from '@shared/rpc/contracts/pty-channel';
import type { SpawnOptions } from '@shared/domain/terminal';
import { TerminalSession } from './terminal-session';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

/** A PTY whose output the test pushes by hand. */
function fakePty() {
  let onData: (data: string) => void = () => undefined;
  let onExit: (e: { exitCode: number; signal?: number }) => void = () => undefined;
  const pty = {
    pid: 42,
    onData: (l: (data: string) => void) => ((onData = l), { dispose: () => undefined }),
    onExit: (l: (e: { exitCode: number; signal?: number }) => void) => ((onExit = l), { dispose: () => undefined }),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
  } as unknown as IPty;
  return { pty, output: (data: string) => onData(data), exit: (exitCode: number) => onExit({ exitCode }) };
}

const opts = (extra: Partial<SpawnOptions> = {}): SpawnOptions => ({
  id: 't1',
  file: 'shell',
  args: [],
  cwd: '/',
  env: {},
  cols: 40,
  rows: 6,
  scrollback: 100,
  ...extra,
});

describe('TerminalSession restore', () => {
  it('writes PTY output that arrives while the buffer is restored after the separator', async () => {
    const fake = fakePty();
    const session = new TerminalSession(opts({ restore: { data: 'old line', label: 'Restarted' } }), {
      spawnPty: () => fake.pty,
      emit: vi.fn(),
      logger,
      platform: 'linux',
    });
    fake.output('$ ');
    const text = await session.getText();
    expect(text.split('\n').map((l) => l.trimEnd())).toEqual(['old line', '── Restarted ──', '$']);
    session.dispose();
  });

  it('on Windows starts the new process on an empty screen below the restored lines', async () => {
    const fake = fakePty();
    const session = new TerminalSession(
      opts({ restore: { data: 'PS C:\\app> dir\r\nfile\r\nPS C:\\app> ', label: 'Session restored' } }),
      { spawnPty: () => fake.pty, emit: vi.fn(), logger, platform: 'win32', windowsBuild: 22631 },
    );
    // ConPTY's first frame clears the screen and draws the prompt at the top-left.
    fake.output('\x1b[?25l\x1b[2J\x1b[m\x1b[HPS C:\\app> \x1b[?25h');
    const sent: PtyToRenderer[] = [];
    session.attach({ send: (m) => sent.push(m) });
    await vi.waitFor(() => expect(sent[0]?.t).toBe('snapshot'));
    const text = await session.getText();
    expect(text.split('\n').map((l) => l.trimEnd())).toEqual([
      'PS C:\\app> dir',
      'file',
      'PS C:\\app>',
      '── Session restored ──',
      'PS C:\\app>',
    ]);
    const snapshot = sent[0] as Extract<PtyToRenderer, { t: 'snapshot' }>;
    expect(snapshot.data).not.toContain('\x1b[?25l');
    session.dispose();
  });

  it('reports an exit during the restore after the held output', async () => {
    const fake = fakePty();
    const emit = vi.fn();
    const session = new TerminalSession(opts({ restore: { data: 'old', label: 'Restarted' } }), {
      spawnPty: () => fake.pty,
      emit,
      logger,
      platform: 'linux',
    });
    fake.output('bye');
    fake.exit(0);
    expect(session.alive).toBe(true);
    await vi.waitFor(() => expect(session.alive).toBe(false));
    expect(await session.getText()).toContain('bye');
    expect(emit).toHaveBeenCalledWith('terminal:exit', { id: 't1', exitCode: 0 });
    session.dispose();
  });
});
