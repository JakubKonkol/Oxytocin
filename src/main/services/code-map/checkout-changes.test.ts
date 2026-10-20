import { expect, it, vi } from 'vitest';
import type { RepoStatus } from '@shared/domain/git';
import { checkoutChanges } from './checkout-changes';

function setup() {
  let registered = true;
  const deps = {
    root: vi.fn((_p: string, c: string) => {
      if (!registered || !['p', 'worktree:t'].includes(c)) throw new Error('Checkout not authorized');
      return c === 'p' ? '/project' : '/worktree';
    }),
    status: () =>
      ({
        state: 'ok',
        files: [
          { path: 'src/api.ts', status: 'modified' },
          { path: '.oxy/graph.json', status: 'modified' },
        ],
      }) as RepoStatus,
    task: () => ({ projectId: 'p', path: '/worktree', baseCommit: 'a'.repeat(40) }),
    changes: vi.fn(() => Promise.resolve([{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' as const }])),
  };
  return {
    deps,
    revoke: () => {
      registered = false;
    },
  };
}
it('compares the main checkout with HEAD and the registered worktree with its stored base', async () => {
  const { deps } = setup();
  expect(await checkoutChanges({ projectId: 'p', checkoutId: 'p' }, deps)).toMatchObject({
    comparison: 'head',
    total: 1,
    truncated: false,
    files: [{ path: 'src/api.ts', status: 'modified' }],
  });
  expect(await checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).toMatchObject({
    comparison: 'worktree-base',
    baseCommit: 'a'.repeat(40),
    files: [{ path: 'src/new.ts', oldPath: 'src/old.ts' }],
  });
  expect(deps.changes).toHaveBeenCalledWith('t');
  deps.task = () => ({ projectId: 'foreign', path: '/worktree', baseCommit: 'a'.repeat(40) });
  await expect(checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).rejects.toThrow(
    'base is unavailable',
  );
});
it('bounds changes, refuses invalid paths and rechecks authorization after Git returns', async () => {
  const { deps, revoke } = setup();
  deps.changes.mockResolvedValue(
    Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.ts`, oldPath: 'old.ts', status: 'renamed' as const })),
  );
  expect(await checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).toMatchObject({
    total: 501,
    truncated: true,
  });
  expect((await checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).files).toHaveLength(500);
  deps.changes.mockResolvedValue([{ path: '../escape.ts', oldPath: 'a.ts', status: 'renamed' }]);
  await expect(checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).rejects.toThrow();
  deps.changes.mockImplementation(() => {
    revoke();
    return Promise.resolve([]);
  });
  await expect(checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).rejects.toThrow('not authorized');
});
it('bounds UTF-8 change metadata and refuses unknown Git state or a changed base', async () => {
  const { deps } = setup();
  deps.changes.mockResolvedValue(
    Array.from({ length: 500 }, (_, i) => ({
      path: `${i}/${'😀'.repeat(1500)}.ts`,
      oldPath: 'old.ts',
      status: 'renamed' as const,
    })),
  );
  const result = await checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
  expect(result.truncated).toBe(true);
  deps.status = () => null as unknown as RepoStatus;
  await expect(checkoutChanges({ projectId: 'p', checkoutId: 'p' }, deps)).rejects.toThrow('Git status is unavailable');
  deps.changes.mockImplementation(() => {
    deps.task = () => ({ projectId: 'p', path: '/worktree', baseCommit: 'b'.repeat(40) });
    return Promise.resolve([]);
  });
  await expect(checkoutChanges({ projectId: 'p', checkoutId: 'worktree:t' }, deps)).rejects.toThrow(
    'changed during comparison',
  );
});
