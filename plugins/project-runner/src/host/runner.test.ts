import type { TerminalMeta } from '@oxytocin/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunProfile } from './profiles';
import { profileFolder, RunManager } from './runner';

const profile: RunProfile = {
  id: 'node:web',
  name: 'web',
  command: 'npm run dev',
  cwd: 'web',
  kind: 'node',
  source: 'detected',
  url: 'http://localhost:5173',
};

/** A fake terminals API: terminals are created running with shell integration. */
function fakeTerminals() {
  const terminals = new Map<string, TerminalMeta>();
  const output = new Map<string, (data: string) => void>();
  let next = 1;
  const api = {
    list: vi.fn(() => Promise.resolve([...terminals.values()])),
    create: vi.fn((o: { projectId: string; cwd?: string; title?: string; command?: string }) => {
      const meta: TerminalMeta = {
        id: `t${next++}`,
        projectId: o.projectId,
        profileId: 'bash',
        title: o.title ?? 'bash',
        status: 'running',
        kind: 'shell',
        createdAt: 0,
        background: true,
        shellIntegration: true,
      };
      terminals.set(meta.id, meta);
      return Promise.resolve(meta);
    }),
    sendText: vi.fn(() => Promise.resolve()),
    show: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve()),
    close: vi.fn((id: string) => {
      terminals.delete(id);
      return Promise.resolve();
    }),
    getListeningPorts: vi.fn(() => Promise.resolve([] as number[])),
    onDidWriteData: vi.fn((id: string, listener: (data: string) => void) => {
      output.set(id, listener);
      return { dispose: () => output.delete(id) };
    }),
  };
  const update = (id: string, patch: Partial<TerminalMeta>) => {
    const meta = { ...terminals.get(id)!, ...patch };
    terminals.set(id, meta);
    return meta;
  };
  return { api, terminals, output, update };
}

describe('RunManager', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const t = fakeTerminals();
    const runs = new RunManager({ terminals: t.api, stopDelays: { interrupt: 1000, kill: 2000 }, settleMs: 3000 });
    const changes: string[] = [];
    runs.onDidChange((p) => changes.push(p));
    return { t, runs, changes };
  };

  it('starts a profile in a background terminal and becomes running when the URL appears', async () => {
    const { t, runs, changes } = setup();
    const snap = await runs.start('/p', 'p1', profile, 'user');
    expect(snap).toMatchObject({ status: 'starting', startedBy: 'user', terminalId: 't1' });
    expect(t.api.create).toHaveBeenCalledWith({
      projectId: 'p1',
      cwd: '/p/web',
      title: 'web',
      command: 'npm run dev',
      reveal: false,
    });
    t.output.get('t1')!('\x1b[32m  ➜  Local:   http://localhost:5174/\x1b[0m\r\n');
    expect(runs.snapshot('p1', profile.id)).toMatchObject({ status: 'running', url: 'http://localhost:5174/' });
    expect(changes.length).toBeGreaterThan(1);
    expect(runs.logs('p1', profile.id, 5)).toEqual(['  ➜  Local:   http://localhost:5174/']);
    // Starting again while running is a no-op.
    await runs.start('/p', 'p1', profile, 'agent');
    expect(t.api.create).toHaveBeenCalledTimes(1);
  });

  it('tracks the command end through shell integration and reuses the idle terminal', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    runs.onTerminalChange(t.update('t1', { command: { commandLine: 'npm run dev', startedAt: 1_000_100 } }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs.snapshot('p1', profile.id).status).toBe('running');
    runs.onTerminalChange(
      t.update('t1', {
        command: undefined,
        lastCommand: { commandLine: 'npm run dev', exitCode: 1, durationMs: 10, finishedAt: 1_004_000 },
      }),
    );
    expect(runs.snapshot('p1', profile.id)).toMatchObject({ status: 'failed', exitCode: 1 });
    // Run again: the shell is idle, the command is typed into it.
    await runs.start('/p', 'p1', profile, 'agent');
    expect(t.api.create).toHaveBeenCalledTimes(1);
    expect(t.api.sendText).toHaveBeenCalledWith('t1', 'npm run dev');
    expect(runs.snapshot('p1', profile.id)).toMatchObject({ status: 'starting', startedBy: 'agent' });
  });

  it('stops with Ctrl+C and escalates to a forced kill', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    runs.onTerminalChange(t.update('t1', { command: { startedAt: 1_000_050 } }));
    await runs.stop('p1', profile.id);
    expect(t.api.sendText).toHaveBeenCalledWith('t1', '\x03', { addNewLine: false });
    expect(runs.snapshot('p1', profile.id).status).toBe('stopping');
    // Windows batch files ask before terminating.
    t.output.get('t1')!('Terminate batch job (Y/N)? ');
    expect(t.api.sendText).toHaveBeenCalledWith('t1', 'Y');
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.api.sendText.mock.calls.filter((c) => (c as unknown[])[1] === '\x03')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.api.kill).toHaveBeenCalledWith('t1', { force: true });
    expect(runs.snapshot('p1', profile.id).status).toBe('stopped');
  });

  it('treats an interrupted command as stopped and the closed terminal as gone', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    runs.onTerminalChange(t.update('t1', { command: { startedAt: 1_000_050 } }));
    runs.onTerminalChange(
      t.update('t1', { command: undefined, lastCommand: { exitCode: 130, durationMs: 5, finishedAt: 1_000_900 } }),
    );
    expect(runs.snapshot('p1', profile.id).status).toBe('stopped');
    runs.onTerminalClose('t1');
    expect(runs.snapshot('p1', profile.id).terminalId).toBeUndefined();
    expect(await runs.showLogs('p1', profile.id)).toBe(false);
  });

  it('falls back to the foreground process without shell integration and reads listening ports', async () => {
    const { t, runs } = setup();
    t.api.getListeningPorts.mockResolvedValue([24678, 5173]);
    await runs.start('/p', 'p1', profile, 'user');
    t.update('t1', { shellIntegration: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs.snapshot('p1', profile.id)).toMatchObject({
      status: 'running',
      ports: [24678, 5173],
      url: 'http://localhost:5173',
    });
    runs.onTerminalChange(t.update('t1', { kind: 'process' }));
    runs.onTerminalChange(t.update('t1', { kind: 'shell' }));
    expect(runs.snapshot('p1', profile.id)).toMatchObject({ status: 'stopped', ports: [] });
  });

  it('replaces an exited background terminal and shows logs on demand', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    runs.onTerminalChange(t.update('t1', { status: 'exited', exitCode: 2 }));
    expect(runs.snapshot('p1', profile.id)).toMatchObject({ status: 'failed', exitCode: 2 });
    await runs.start('/p', 'p1', profile, 'user');
    expect(t.api.close).toHaveBeenCalledWith('t1');
    expect(runs.snapshot('p1', profile.id).terminalId).toBe('t2');
    expect(await runs.showLogs('p1', profile.id, true)).toBe(true);
    expect(t.api.show).toHaveBeenCalledWith('t2', { preserveFocus: true });
  });

  it('waits for a state and restarts', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    const ready = runs.waitFor('p1', profile.id, (s) => s.status === 'running', 10_000);
    t.output.get('t1')!('listening on port 4000\n');
    await expect(ready).resolves.toMatchObject({ status: 'running', url: 'http://localhost:4000' });
    const restarted = runs.restart('/p', 'p1', profile, 'user');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(restarted).resolves.toMatchObject({ status: 'starting' });
    expect(runs.active().map((r) => r.projectId)).toEqual(['p1']);
  });

  it('starts once when asked twice at the same time', async () => {
    const { t, runs } = setup();
    await Promise.all([runs.start('/p', 'p1', profile, 'user'), runs.start('/p', 'p1', profile, 'agent')]);
    expect(t.api.create).toHaveBeenCalledTimes(1);
    expect(runs.snapshot('p1', profile.id).startedBy).toBe('user');
  });

  it('cancels a start that is stopped while its terminal is being created', async () => {
    const { t, runs } = setup();
    let release!: () => void;
    const created = t.api.create.getMockImplementation()!;
    t.api.create.mockImplementationOnce((o) => new Promise((r) => (release = () => r(created(o)))));
    const starting = runs.start('/p', 'p1', profile, 'user');
    await vi.advanceTimersByTimeAsync(0);
    await runs.stop('p1', profile.id);
    expect(runs.snapshot('p1', profile.id).status).toBe('stopping');
    release();
    await expect(starting).resolves.toMatchObject({ status: 'stopped' });
    expect(t.api.close).toHaveBeenCalledWith('t1');
    expect(t.api.sendText).not.toHaveBeenCalled();
  });

  it('does not reuse a terminal whose shell moved to another folder, and stops streaming output after a run', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    runs.onTerminalChange(t.update('t1', { command: { startedAt: 1_000_050 }, cwd: '/p/web' }));
    runs.onTerminalChange(
      t.update('t1', { command: undefined, lastCommand: { exitCode: 0, durationMs: 5, finishedAt: 1_000_900 } }),
    );
    expect(t.output.has('t1')).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.output.has('t1')).toBe(false);
    t.update('t1', { cwd: '/elsewhere' });
    await runs.start('/p', 'p1', profile, 'user');
    expect(t.api.create).toHaveBeenCalledTimes(2);
    expect(runs.snapshot('p1', profile.id)).toMatchObject({ terminalId: 't2', name: 'web' });
  });

  it('remembers run terminals and adopts a running one after a restart of the plugin', async () => {
    const { t, runs } = setup();
    await runs.start('/p', 'p1', profile, 'user');
    expect(runs.terminalLinks()).toEqual([
      { terminalId: 't1', projectId: 'p1', profileId: profile.id, setup: JSON.stringify(['/p/web', {}]) },
    ]);
    const meta = t.update('t1', { command: { startedAt: 999_000 } });
    const next = new RunManager({ terminals: t.api });
    next.adopt('p1', profile, meta, JSON.stringify(['/p/web', {}]));
    expect(next.snapshot('p1', profile.id)).toMatchObject({ status: 'running', terminalId: 't1', startedAt: 999_000 });
    t.output.get('t1')!('Local: http://localhost:5199/\n');
    expect(next.snapshot('p1', profile.id).url).toBe('http://localhost:5199/');
    // An idle shell is adopted as stopped; exited terminals are ignored.
    const idle = new RunManager({ terminals: t.api });
    idle.adopt('p1', profile, { ...meta, command: undefined });
    expect(idle.snapshot('p1', profile.id).status).toBe('stopped');
    const gone = new RunManager({ terminals: t.api });
    gone.adopt('p1', profile, { ...meta, status: 'exited' });
    expect(gone.snapshot('p1', profile.id).status).toBe('idle');
  });

  it('builds folders with the root separator', () => {
    expect(profileFolder('C:\\work\\app', 'apps/web')).toBe('C:\\work\\app\\apps\\web');
    expect(profileFolder('/p/', '')).toBe('/p/');
    expect(profileFolder('/p', 'a/b')).toBe('/p/a/b');
  });
});
