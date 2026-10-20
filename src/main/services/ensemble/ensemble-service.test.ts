import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EnsembleService, type EnsembleServiceDeps } from './ensemble-service';

const off = () => ({ dispose() {} });

it('deletes a task even when removing its Code Map registration fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oxy-ensemble-'));
  const warn = vi.fn();
  const remove = vi.fn().mockRejectedValue(new Error('Code Map Host unavailable'));
  const service = new EnsembleService({
    dir,
    logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    settings: () => ({}) as ReturnType<EnsembleServiceDeps['settings']>,
    projects: { get: (id) => (id === 'p' ? { id: 'p', name: 'P', rootPath: dir } : undefined) },
    terminals: {
      create: () => Promise.reject(new Error('unused')),
      get: () => undefined,
      kill: () => Promise.resolve(),
      close: () => Promise.resolve(),
      onDidUpdate: off,
      onDidRemove: off,
    },
    agents: { list: () => [], onDidUpdate: off },
    pty: {
      paste: () => Promise.resolve(),
      write: () => Promise.resolve(),
      text: () => Promise.resolve(''),
      onActivity: off,
    },
    workspace: () => Promise.reject(new Error('unused')),
    mcp: { url: () => null, status: () => ({ enabled: false, running: false, error: null }), endSessions: () => {} },
    detect: () => Promise.resolve({ installed: false }),
    bridgeEnabled: () => false,
    notify: () => {},
    platform: process.platform,
    codeMap: { ready: () => Promise.resolve(), remove },
    tickMs: 0,
  });
  try {
    const task = await service.create({ projectId: 'p', templateId: 'feature' });
    await service.remove(task.task.id);
    expect(remove).toHaveBeenCalledWith(task.task.id);
    expect(service.get(task.task.id)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Code Map'), expect.any(Error));
  } finally {
    service.dispose();
    await service.flush();
    await rm(dir, { recursive: true, force: true });
  }
});
