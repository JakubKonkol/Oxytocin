import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Project } from '@shared/domain/project';
import { initialCodeMapStatus } from '@shared/domain/code-map';
import { CodeMapService } from './code-map-service';

it('registers isolated worktrees, inherits options and revokes in-flight readers before removal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oxy-worktrees-')));
  await Promise.all(['one', 'two', 'p1', 'p2'].map((name) => mkdir(join(root, name))));
  type Deps = ConstructorParameters<typeof CodeMapService>[0];
  const projects: Project[] = ['p1', 'p2'].map((id) => ({
    id,
    name: id,
    rootPath: join(root, id),
    color: 0,
    pinned: false,
    order: 0,
    createdAt: 0,
    settings: { codeMap: { enabled: true, ignoreInGit: false, excludedPaths: ['generated/**'] } },
  }));
  let release: ((v: unknown) => void) | undefined;
  const call = vi.fn<Deps['host']['call']>().mockImplementation((method, input) => {
    if (method === 'query:run')
      return new Promise((resolve) => {
        release = resolve;
      }) as never;
    if (method === 'checkout:remove') return Promise.resolve(null) as never;
    return Promise.resolve(initialCodeMapStatus((input as { checkoutId: string }).checkoutId)) as never;
  });
  const host: Deps['host'] = {
    state: 'running',
    start: () => {},
    stop: () => Promise.resolve(),
    call,
    onEvent: () => ({ dispose() {} }),
    onDidBecomeReady: () => ({ dispose() {} }),
    onDidChangeState: () => ({ dispose() {} }),
  };
  const service = new CodeMapService({
    host,
    projects: {
      get: (id) => projects.find((p) => p.id === id),
      list: () => projects,
      update: () => Promise.resolve(projects[0]!),
      onDidChange: () => ({ dispose() {} }),
    },
    gitPath: () => 'git',
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    await service.start();
    await service.registerWorktree('p1', 'one', join(root, 'one'));
    await service.registerWorktree('p2', 'two', join(root, 'two'));
    expect(call).toHaveBeenCalledWith(
      'checkout:configure',
      expect.objectContaining({
        checkoutId: 'worktree:one',
        projectId: 'p1',
        mode: 'worktree',
        ignoreInGit: true,
        excludedPaths: ['generated/**'],
      }),
      expect.anything(),
    );
    expect(service.checkoutRoot('p1', 'worktree:one')).toBe(join(root, 'one'));
    expect(() => service.checkoutRoot('p1', 'worktree:two')).toThrow('no longer registered');
    const pending = service.query('p1', { kind: 'status' }, new AbortController().signal, 'worktree:one');
    await vi.waitFor(() => expect(release).toBeDefined());
    const status = initialCodeMapStatus('worktree:one');
    const answer = {
      checkoutId: 'worktree:one',
      code: 'OK',
      truncated: false,
      reasons: [],
      hint: '',
      freshness: {
        generation: 0,
        state: 'ready',
        stale: false,
        verification: 'metadata',
        checkedAt: null,
        lastFullHashAt: null,
        pendingFiles: 0,
        coverage: status.coverage,
        warnings: [],
      },
    };
    await service.removeWorktree('one');
    expect(call).toHaveBeenCalledWith(
      'memory:archive',
      expect.objectContaining({ projectId: 'p1', checkoutId: 'worktree:one', root: join(root, 'one') }),
      expect.anything(),
    );
    expect(call.mock.calls.findIndex(([method]) => method === 'memory:archive')).toBeLessThan(
      call.mock.calls.findIndex(([method]) => method === 'checkout:remove'),
    );
    release!(answer);
    await expect(pending).rejects.toThrow('no longer registered');
    await expect(service.query('p1', { kind: 'status' }, new AbortController().signal, 'worktree:one')).rejects.toThrow(
      'no longer registered',
    );
    expect(service.registeredCheckouts().map((c) => c.id)).toContain('worktree:two');
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('never registers a worktree removed while its registration waited, and lists worktrees of disabled projects', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oxy-worktrees-')));
  await Promise.all(['one', 'two', 'p1'].map((name) => mkdir(join(root, name))));
  type Deps = ConstructorParameters<typeof CodeMapService>[0];
  const project: Project = {
    id: 'p1',
    name: 'p1',
    rootPath: join(root, 'p1'),
    color: 0,
    pinned: false,
    order: 0,
    createdAt: 0,
    settings: { codeMap: { enabled: true, ignoreInGit: false, excludedPaths: [] } },
  };
  let unblock: (() => void) | undefined;
  const call = vi.fn<Deps['host']['call']>().mockImplementation((method, input) => {
    const status = initialCodeMapStatus((input as { checkoutId: string }).checkoutId);
    if (method === 'checkout:configure' && status.checkoutId === 'p1')
      return new Promise((resolve) => {
        unblock = () => resolve(status);
      }) as never;
    return Promise.resolve(method === 'checkout:remove' ? null : status) as never;
  });
  const service = new CodeMapService({
    host: {
      state: 'running',
      start: () => {},
      stop: () => Promise.resolve(),
      call,
      onEvent: () => ({ dispose() {} }),
      onDidBecomeReady: () => ({ dispose() {} }),
      onDidChangeState: () => ({ dispose() {} }),
    },
    projects: {
      get: (id) => (id === project.id ? project : undefined),
      list: () => [project],
      update: () => Promise.resolve(project),
      onDidChange: () => ({ dispose() {} }),
    },
    gitPath: () => 'git',
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    // The project's own configuration keeps the queue busy while the worktree registration waits behind it.
    const started = service.start();
    await vi.waitFor(() => expect(unblock).toBeDefined());
    const registered = service.registerWorktree('p1', 'one', join(root, 'one'));
    const removed = service.removeWorktree('one');
    unblock!();
    await Promise.all([started, registered, removed]);
    expect(service.registeredCheckouts().map((c) => c.id)).toEqual(['p1']);
    expect(call).not.toHaveBeenCalledWith(
      'checkout:configure',
      expect.objectContaining({ checkoutId: 'worktree:one' }),
      expect.anything(),
    );

    project.settings = { codeMap: { enabled: false, ignoreInGit: false, excludedPaths: [] } };
    await service.registerWorktree('p1', 'two', join(root, 'two'));
    expect(service.registeredCheckouts()).toContainEqual(
      expect.objectContaining({ id: 'worktree:two', projectId: 'p1', rootPath: join(root, 'two') }),
    );
    expect(() => service.checkoutRoot('p1', 'worktree:two')).toThrow('disabled');
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
