import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSettings, type Settings } from '@shared/domain/settings';
import type { UpdateState } from '@shared/domain/updates';
import { Emitter } from '@shared/utils/emitter';
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, UpdateService, type UpdaterBackend } from './update-service';

const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function setup(opts: { raw?: Record<string, unknown>; backend?: UpdaterBackend | null } = {}) {
  let settings: Settings = resolveSettings(opts.raw ?? {}, 'linux').settings;
  const settingsChanged = new Emitter<Settings>();
  let release: (() => void) | undefined;
  const progress: ((p: number) => void)[] = [];
  const next: { value: { version: string } | null | Error } = { value: null };
  const setChannel = vi.fn();
  const check = vi.fn(() => (next.value instanceof Error ? Promise.reject(next.value) : Promise.resolve(next.value)));
  const download = vi.fn(
    (onProgress: (p: number) => void) =>
      new Promise<void>((resolve) => {
        progress.push(onProgress);
        release = resolve;
      }),
  );
  const install = vi.fn(() => true);
  const backend: UpdaterBackend = { setChannel, check, download, install };
  const requestQuit = vi.fn();
  const service = new UpdateService({
    currentVersion: '0.1.0',
    backend: opts.backend === undefined ? backend : opts.backend,
    disabledReason: 'Dev build.',
    settings: () => settings,
    onDidChangeSettings: (l) => settingsChanged.event(l),
    requestQuit,
    logger: silentLogger,
    now: () => 1000,
  });
  const states: UpdateState[] = [];
  service.onDidChange((s) => states.push(s));
  return {
    service,
    backend: { setChannel, check, download, install },
    next,
    requestQuit,
    states,
    finishDownload: () => release?.(),
    reportProgress: (p: number) => progress.at(-1)?.(p),
    changeSettings: (raw: Record<string, unknown>) => {
      settings = resolveSettings(raw, 'linux').settings;
      settingsChanged.fire(settings);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('UpdateService', () => {
  it('is disabled without a backend', async () => {
    const { service } = setup({ backend: null });
    expect(service.get()).toEqual({ currentVersion: '0.1.0', status: 'idle', disabledReason: 'Dev build.' });
    expect(await service.check()).toMatchObject({ status: 'idle' });
    expect(service.restartToUpdate()).toBe(false);
    expect(service.installOnQuit()).toBe(false);
  });

  it('reports an up-to-date app and passes the release channel', async () => {
    const { service, backend } = setup({ raw: { 'updates.channel': 'beta' } });
    expect(await service.check()).toEqual({ currentVersion: '0.1.0', status: 'up-to-date', lastCheck: 1000 });
    expect(backend.setChannel).toHaveBeenCalledWith('beta');
  });

  it('downloads a newer version in the background, then offers it', async () => {
    const { service, backend, next, states, reportProgress, finishDownload } = setup();
    next.value = { version: '0.2.0' };
    expect(await service.check()).toMatchObject({ status: 'downloading', version: '0.2.0', percent: 0 });
    reportProgress(41.7);
    reportProgress(41.9);
    expect(service.get()).toMatchObject({ status: 'downloading', percent: 41 });
    // A second check while downloading does not start another download.
    await service.check();
    expect(backend.download).toHaveBeenCalledTimes(1);
    finishDownload();
    await vi.waitFor(() => expect(service.get()).toMatchObject({ status: 'ready', version: '0.2.0' }));
    expect(states.map((s) => s.status)).toEqual(['checking', 'downloading', 'downloading', 'ready']);
  });

  it('reports check errors and recovers on the next check', async () => {
    const { service, next } = setup();
    next.value = new Error('net::ERR_INTERNET_DISCONNECTED');
    expect(await service.check()).toMatchObject({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
    next.value = null;
    expect(await service.check()).toMatchObject({ status: 'up-to-date' });
  });

  it('never restarts on its own: installs on quit, restarts only when asked, and a cancelled quit resets', async () => {
    const { service, backend, next, requestQuit, finishDownload } = setup();
    next.value = { version: '0.2.0' };
    await service.check();
    finishDownload();
    await vi.waitFor(() => expect(service.get().status).toBe('ready'));
    expect(requestQuit).not.toHaveBeenCalled();

    expect(service.restartToUpdate()).toBe(true);
    expect(requestQuit).toHaveBeenCalledTimes(1);
    service.cancelRestart(); // QuitGuard: Cancel
    expect(service.installOnQuit()).toBe(true);
    expect(backend.install).toHaveBeenLastCalledWith(false);

    service.restartToUpdate();
    service.installOnQuit();
    expect(backend.install).toHaveBeenLastCalledWith(true);
  });

  it('checks at start and every 6 hours, following the setting', async () => {
    const { service, backend, changeSettings } = setup();
    service.start();
    expect(backend.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.check).toHaveBeenCalledTimes(2);

    changeSettings({ 'updates.checkAutomatically': false });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.check).toHaveBeenCalledTimes(2);
    changeSettings({});
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.check).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it('does not check automatically when turned off', async () => {
    const { service, backend } = setup({ raw: { 'updates.checkAutomatically': false } });
    service.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.check).not.toHaveBeenCalled();
  });
});
