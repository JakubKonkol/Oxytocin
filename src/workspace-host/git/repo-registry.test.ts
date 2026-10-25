import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatchRepoRequest } from '@shared/rpc/contracts/workspace-host';
import { discoverRepo } from './discover';
import { RepoRegistry } from './repo-registry';

vi.mock('./discover', () => ({ discoverRepo: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const request = (gitPath = 'git'): WatchRepoRequest => ({
  projectId: 'p',
  rootPath: '/project',
  gitPath,
  maxFiles: 100,
  ignoredFolders: [],
});

function setup() {
  vi.useFakeTimers();
  const unsubscribing = Promise.withResolvers<void>();
  const unsubscribe = vi.fn(() => unsubscribing.promise);
  const emitRepo = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  vi.mocked(discoverRepo).mockResolvedValue({ state: 'not-a-repo' });
  const subscribe = vi.fn().mockResolvedValue({ unsubscribe });
  const registry = new RepoRegistry({
    subscribe,
    emitRepo,
    emitTouched: vi.fn(),
    onRefresh,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { registry, unsubscribing, unsubscribe, subscribe, emitRepo, onRefresh };
}

describe('RepoRegistry lifecycle', () => {
  it('keeps the newest watch request when an older replacement is still unsubscribing', async () => {
    const { registry, unsubscribing } = setup();
    await registry.watch(request());
    await vi.advanceTimersByTimeAsync(0);
    const older = registry.watch(request('older-git'));
    await registry.watch(request('newest-git'));
    unsubscribing.resolve();
    await older;
    expect(registry.get('p')?.req.gitPath).toBe('newest-git');
    await registry.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unwatch', 'dispose'] as const)('does not resurrect a pending replacement after %s', async (action) => {
    const { registry, unsubscribing } = setup();
    await registry.watch(request());
    await vi.advanceTimersByTimeAsync(0);
    const replacing = registry.watch(request('other-git'));
    if (action === 'unwatch') await registry.unwatch('p');
    else await registry.dispose();
    unsubscribing.resolve();
    await replacing;
    expect(registry.get('p')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await registry.dispose();
  });

  it('does not publish discovery or refresh a project removed during discovery', async () => {
    const { registry, emitRepo, onRefresh, subscribe } = setup();
    const finding = Promise.withResolvers<Awaited<ReturnType<typeof discoverRepo>>>();
    vi.mocked(discoverRepo).mockReturnValue(finding.promise);
    await registry.watch(request());
    await vi.advanceTimersByTimeAsync(0);
    await registry.unwatch('p');
    finding.resolve({
      state: 'ok',
      toplevel: '/project',
      gitDir: '/project/.git',
      commonDir: '/project/.git',
      pathspec: null,
      hasHead: true,
      isBare: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(emitRepo).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    await registry.dispose();
  });
});
