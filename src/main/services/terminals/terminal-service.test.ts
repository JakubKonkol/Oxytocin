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
      if (method === 'serialize') return Promise.resolve({ seq: 1, data: 'old output' });
      return Promise.resolve(method === 'spawn' ? { pid: pid++ } : undefined);
    }),
    onEvent: (name: string, l: (p: unknown) => void) => {
      listeners.set(name, l);
      return toDisposable(() => listeners.delete(name));
    },
    onDidBecomeReady: ready.event,
  };
  const settings = {
    ...defaultSettings('linux'),
    'terminal.env': { FROM_SETTINGS: '1' },
    'terminal.profiles': [
      { id: 'custom', name: 'Custom', kind: 'shell', file: '/bin/bash', args: ['--norc'], source: 'user' },
      { id: 'agent:fake', name: 'Fake', kind: 'agent', file: '', args: [], command: 'fake-agent', source: 'user' },
    ],
  } as Settings;
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
    resolveProject: (id) =>
      id === 'p1'
        ? { rootPath: tmpdir(), env: { FROM_PROJECT: '1' } }
        : id === 'p2'
          ? { rootPath: tmpdir(), defaultProfileId: 'custom' }
          : id === 'p3'
            ? { rootPath: tmpdir(), defaultProfileId: 'gone' }
            : null,
    shellIntegration: () => Promise.resolve({ dir: '/si', pwsh: 'x' }),
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
    expect(spawn.args).toEqual(['--init-file', '/si/bash.sh']);
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
    const respawn = calls.at(-1)!.params as { restore?: { data: string; label: string } };
    expect(respawn.restore).toEqual({ data: 'old output', label: 'Restarted' });
    expect(removed).toEqual([first.id]);
    expect(calls.map((c) => c.method)).toEqual(['spawn', 'serialize', 'kill', 'dispose', 'spawn']);
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

  it('uses the project default profile, falling back when it no longer exists', async () => {
    const { svc } = setup();
    expect((await svc.create({ projectId: 'p2' })).profileId).toBe('custom');
    expect((await svc.create({ projectId: 'p2', profileId: 'bash' })).profileId).toBe('bash');
    expect((await svc.create({ projectId: 'p3' })).profileId).toBe('bash');
    await expect(svc.create({ projectId: 'p3', profileId: 'gone' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('injects shell integration and tracks command events', async () => {
    const { svc, calls, emit } = setup();
    const info = await svc.create({ projectId: 'p1' });
    const spawn = calls.find((c) => c.method === 'spawn')!.params as { args: string[]; shellIntegration?: boolean };
    expect(spawn.args).toEqual(['--init-file', '/si/bash.sh']);
    expect(spawn.shellIntegration).toBe(true);
    emit('terminal:command', { id: info.id, phase: 'prompt' });
    expect(svc.get(info.id)?.shellIntegration).toBe(true);
    emit('terminal:command', { id: info.id, phase: 'start', commandLine: 'make' });
    expect(svc.get(info.id)?.command?.commandLine).toBe('make');
    emit('terminal:command', { id: info.id, phase: 'end', commandLine: 'make', exitCode: 2, durationMs: 1500 });
    expect(svc.get(info.id)?.command).toBeUndefined();
    expect(svc.get(info.id)?.lastCommand).toMatchObject({ commandLine: 'make', exitCode: 2, durationMs: 1500 });
  });

  it('starts only the shell of an agent profile when asked to skip its command (restored terminals)', async () => {
    const { svc, calls } = setup();
    const agent = await svc.create({ projectId: 'p1', profileId: 'agent:fake' });
    expect(agent.kind).toBe('agent');
    const restored = await svc.create({ projectId: 'p1', profileId: 'agent:fake', skipInitialCommand: true });
    expect(restored.kind).toBe('shell');
    const spawns = calls.filter((c) => c.method === 'spawn').map((c) => c.params as { initialCommand?: string });
    expect(spawns.map((s) => s.initialCommand)).toEqual(['fake-agent', undefined]);
  });

  it('starts background terminals with extra env and keeps them background until shown', async () => {
    const { svc, calls } = setup();
    const info = await svc.create({ projectId: 'p1', background: true, env: { PORT: '4000', FROM_PROJECT: null } });
    expect(info.background).toBe(true);
    const env = (calls.find((c) => c.method === 'spawn')!.params as { env: Record<string, string> }).env;
    expect(env['PORT']).toBe('4000');
    expect(env['FROM_PROJECT']).toBeUndefined();
    svc.markShown(info.id);
    expect(svc.get(info.id)?.background).toBeUndefined();
    const restarted = await svc.restart(info.id);
    expect(restarted.background).toBeUndefined();
  });

  it('asks the PTY host for output while at least one watcher is registered', async () => {
    const { svc, calls, emit } = setup();
    const info = await svc.create({ projectId: 'p1' });
    const seen: string[] = [];
    svc.onDidOutput((e) => seen.push(e.data));
    await svc.watchOutput(info.id, 'plugin:a', true);
    await svc.watchOutput(info.id, 'plugin:b', true);
    emit('terminal:output', { id: info.id, data: 'ready on :5173' });
    await svc.watchOutput(info.id, 'plugin:a', false);
    await svc.unwatchAllOutput('plugin:b');
    const watches = calls.filter((c) => c.method === 'watchOutput').map((c) => c.params);
    expect(watches).toEqual([
      { id: info.id, watch: true },
      { id: info.id, watch: false },
    ]);
    expect(seen).toEqual(['ready on :5173']);
  });
});
