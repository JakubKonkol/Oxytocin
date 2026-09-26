import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Settings } from '@shared/domain/settings';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { ProfileService } from './profiles';
import { TerminalService } from './terminal-service';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function setup() {
  const listeners = new Map<string, (p: unknown) => void>();
  const ready = new Emitter<{ pid: number; restarted: boolean }>();
  const calls: { method: string; params: unknown }[] = [];
  let pid = 1000;
  const ptyHost = {
    call: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve(method === 'spawn' ? { pid: pid++ } : undefined);
    }),
    onEvent: (name: string, l: (p: unknown) => void) => {
      listeners.set(name, l);
      return toDisposable(() => listeners.delete(name));
    },
    onDidBecomeReady: ready.event,
  };
  const settings = { ...defaultSettings('linux'), 'terminal.env': { FROM_SETTINGS: '1' } } as Settings;
  const profiles = new ProfileService(
    {
      platform: 'linux',
      env: { PATH: '/bin', SHELL: '/bin/bash' },
      isFile: (p) => Promise.resolve(p === '/bin/bash'),
      readText: () => Promise.resolve(null),
      exec: () => Promise.resolve(null),
    },
    () => settings,
  );
  const svc = new TerminalService({
    ptyHost: ptyHost as never,
    profiles,
    settings: () => settings,
    resolveProject: (id) => (id === 'p1' ? { rootPath: tmpdir(), env: { FROM_PROJECT: '1' } } : null),
    baseEnv: () => ({ PATH: '/bin', CLAUDECODE: '1' }),
    appVersion: '0.1.0',
    dev: false,
    platform: 'linux',
    logger,
  });
  const emit = (name: string, payload: unknown) => listeners.get(name)?.(payload);
  return { svc, calls, emit, ready };
}

describe('TerminalService', () => {
  it('creates terminals with composed env and falls back to the project root for a missing cwd', async () => {
    const { svc, calls } = setup();
    const info = await svc.create({ projectId: 'p1', cwd: '/definitely/missing' });
    expect(info).toMatchObject({
      projectId: 'p1',
      profileId: 'bash',
      title: 'bash',
      pid: 1000,
      cwd: tmpdir(),
      state: 'running',
    });
    const spawn = calls.find((c) => c.method === 'spawn')!.params as { env: Record<string, string>; args: string[] };
    expect(spawn.env).toMatchObject({ FROM_SETTINGS: '1', FROM_PROJECT: '1', OXYTOCIN_TERMINAL_ID: info.id });
    expect(spawn.env['CLAUDECODE']).toBeUndefined();
    expect(spawn.args).toEqual(['-l']);
  });

  it('tracks title, exit, bell and user titles', async () => {
    const { svc, emit } = setup();
    const updates: string[] = [];
    svc.onDidUpdate((i) => updates.push(i.title));
    const info = await svc.create({ projectId: 'p1' });
    emit('terminal:title', { id: info.id, title: 'vim' });
    svc.rename(info.id, 'Editor');
    svc.rename(info.id, '  ');
    emit('terminal:exit', { id: info.id, exitCode: 3 });
    emit('terminal:bell', { id: info.id });
    expect(updates).toEqual(['bash', 'vim', 'Editor', 'vim', 'vim', 'vim']);
    expect(svc.get(info.id)).toMatchObject({ state: 'exited', exitCode: 3, bell: true });
  });

  it('restarts as a new terminal and closes the old one', async () => {
    const { svc, calls } = setup();
    const removed: string[] = [];
    svc.onDidRemove((id) => removed.push(id));
    const first = await svc.create({ projectId: 'p1', userTitle: 'API' });
    const second = await svc.restart(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.title).toBe('API');
    expect(removed).toEqual([first.id]);
    expect(calls.map((c) => c.method)).toEqual(['spawn', 'kill', 'dispose', 'spawn']);
  });

  it('marks running terminals as failed when the PTY host restarts', async () => {
    const { svc, ready } = setup();
    const info = await svc.create({ projectId: 'p1' });
    ready.fire({ pid: 1, restarted: true });
    expect(svc.get(info.id)).toMatchObject({
      state: 'failed',
      pid: null,
      error: 'Disconnected — the PTY host crashed',
    });
  });

  it('rejects unknown projects', async () => {
    const { svc } = setup();
    await expect(svc.create({ projectId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
