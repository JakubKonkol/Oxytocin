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
