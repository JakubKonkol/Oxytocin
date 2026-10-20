import { expect, it, vi } from 'vitest';
import { initialCodeMapStatus } from '@shared/domain/code-map';
import type { Project } from '@shared/domain/project';
import { Emitter } from '@shared/utils/emitter';
import { invokeContract } from '@shared/ipc/contract';
import { CodeMapService } from './code-map-service';

it('starts lazily, reconciles settings/root/restart/removal and deletes disabled data without indexing', async () => {
  type Deps = ConstructorParameters<typeof CodeMapService>[0];
  const changed = new Emitter<Project[]>(),
    ready = new Emitter<{ pid: number; restarted: boolean }>();
  let projects: Project[] = [
    {
      id: 'project',
      name: 'test',
      rootPath: '/work/test',
      color: 0,
      pinned: false,
      order: 0,
      createdAt: 0,
      settings: {},
    },
  ];
  const call = vi.fn<Deps['host']['call']>().mockImplementation((method, params) => {
    if (method === 'checkout:remove') return Promise.resolve(null as never);
    return Promise.resolve(initialCodeMapStatus((params as { checkoutId: string }).checkoutId) as never);
  });
  const host: Deps['host'] = {
    state: 'stopped',
    start: vi.fn(() => {
      Object.assign(host, { state: 'running' });
      ready.fire({ pid: 1, restarted: false });
    }),
    stop: vi.fn(() => {
      Object.assign(host, { state: 'stopped' });
      return Promise.resolve();
    }),
    call,
    onDidBecomeReady: ready.event,
    onDidChangeState: () => ({ dispose() {} }),
    onEvent: () => ({ dispose() {} }),
  };
  const service = new CodeMapService({
    host,
    projects: {
      list: () => projects,
      get: (id) => projects.find((p) => p.id === id),
      onDidChange: changed.event,
      update: (patch) => {
        const p = projects.find((p) => p.id === patch.id)!;
        Object.assign(p, patch);
        changed.fire(projects);
        return Promise.resolve(p);
      },
    },
    gitPath: () => 'git',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await service.start();
  expect(host.start).not.toHaveBeenCalled();
  await expect(service.setEnabled('foreign', true)).rejects.toThrow('Project not found');
  await service.setEnabled('project', true, false);
  await service.start();
  expect(host.start).toHaveBeenCalledTimes(1);
  expect(call.mock.calls.filter(([m]) => m === 'checkout:configure')).toHaveLength(1);
  expect(call).toHaveBeenCalledWith(
    'checkout:configure',
    expect.objectContaining({ root: '/work/test', ignoreInGit: false }),
    expect.anything(),
  );
  projects[0]!.rootPath = '/work/moved';
  changed.fire(projects);
  await service.start();
  expect(call).toHaveBeenLastCalledWith(
    'checkout:configure',
    expect.objectContaining({ root: '/work/moved' }),
    expect.anything(),
  );
  ready.fire({ pid: 2, restarted: true });
  await service.start();
  expect(call.mock.calls.filter(([m]) => m === 'checkout:configure')).toHaveLength(3);
  await service.setOptions('project', { excludedPaths: ['generated/**'], ignoreInGit: false }, true);
  expect(call).toHaveBeenCalledWith(
    'checkout:configure',
    expect.objectContaining({ removeGitignoreEntry: true }),
    expect.anything(),
  );
  await service.setEnabled('project', false);
  await expect(
    service.query('project', { kind: 'search', query: 'secret' }, new AbortController().signal),
  ).rejects.toThrow('Code Map is disabled');
  expect(call).toHaveBeenCalledWith('checkout:remove', { checkoutId: 'project' });
  expect(host.state).toBe('stopped');
  const configurations = call.mock.calls.filter(([m]) => m === 'checkout:configure').length;
  await service.deleteData('project');
  await service.start();
  expect(call).toHaveBeenCalledWith(
    'checkout:deleteData',
    { checkoutId: 'project', root: '/work/moved' },
    expect.anything(),
  );
  expect(call.mock.calls.filter(([m]) => m === 'checkout:configure')).toHaveLength(configurations);
  await service.setEnabled('project', true);
  projects = [];
  changed.fire(projects);
  await service.start();
  expect(host.state).toBe('stopped');
  await service.dispose();
});

it('rejects renderer-supplied roots, invalid options and malformed operation payloads', () => {
  expect(
    invokeContract['codeMap:editInstructions'].req.safeParse({
      projectId: 'p',
      root: '/foreign',
      file: 'CLAUDE.md',
      action: 'add',
    }).success,
  ).toBe(false);
  expect(invokeContract['codeMap:deleteData'].req.safeParse({ projectId: 'p', root: '/foreign' }).success).toBe(false);
  expect(invokeContract['codeMap:setEnabled'].req.safeParse({ projectId: 'p', enabled: 'yes' }).success).toBe(false);
  expect(
    invokeContract['codeMap:setOptions'].req.safeParse({
      projectId: 'p',
      excludedPaths: ['../secret'],
      ignoreInGit: true,
    }).success,
  ).toBe(false);
});
