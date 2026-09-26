import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/domain/project';
import { resolveSettings, type Settings } from '@shared/domain/settings';
import { toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { GitService } from './git-service';

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  rootPath: `/work/${id}`,
  color: 0,
  pinned: false,
  order: 0,
  createdAt: 0,
  settings: {},
  ...extra,
});

function setup(opts: { projects?: Project[]; settings?: Record<string, unknown>; git?: boolean } = {}) {
  let projects = opts.projects ?? [project('a'), project('b')];
  let active: string | null = projects[0]?.id ?? null;
  let settings: Settings = resolveSettings(opts.settings ?? {}, 'linux').settings;
  const calls: { method: string; params: unknown }[] = [];
  const ready = new Emitter<{ restarted: boolean }>();
  const projectsChanged = new Emitter<Project[]>();
  const activeChanged = new Emitter<string | null>();
  const settingsChanged = new Emitter<Settings>();
  const host = {
    call: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'git:detect')
        return Promise.resolve(opts.git === false ? null : { path: 'git', version: '2.43.0', supported: true });
      return Promise.resolve(undefined);
    }),
    onEvent: () => toDisposable(() => undefined),
    onDidBecomeReady: ready.event,
  };
  const service = new GitService({
    host: host as never,
    projects: {
      list: () => projects,
      activeId: () => active,
      onDidChange: projectsChanged.event,
      onDidChangeActive: activeChanged.event,
    },
    settings: () => settings,
    onDidChangeSettings: settingsChanged.event,
    isWindowFocused: () => true,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  });
  const methods = (name: string) => calls.filter((c) => c.method === name).map((c) => c.params);
  return {
    service,
    methods,
    calls,
    setProjects: (p: Project[]) => {
      projects = p;
      projectsChanged.fire(p);
    },
    setActive: (id: string | null) => {
      active = id;
      activeChanged.fire(id);
    },
    setSettings: (raw: Record<string, unknown>) => {
      settings = resolveSettings(raw, 'linux').settings;
      settingsChanged.fire(settings);
    },
    restartHost: () => ready.fire({ restarted: true }),
  };
}

describe('GitService', () => {
  it('watches every project and follows project changes', async () => {
    const s = setup();
    await s.service.sync();
    expect(s.methods('git:watch')).toEqual([
      expect.objectContaining({ projectId: 'a', rootPath: '/work/a', gitPath: 'git' }),
      expect.objectContaining({ projectId: 'b', rootPath: '/work/b' }),
    ]);
    expect(s.methods('git:setActive').at(-1)).toEqual({ projectId: 'a' });
    s.setProjects([project('a')]);
    await s.service.sync();
    expect(s.methods('git:unwatch')).toEqual([{ projectId: 'b' }]);
    // Unchanged projects are not re-watched.
    expect(s.methods('git:watch')).toHaveLength(2);
    s.service.dispose();
  });

  it('honours git.enabled, per-project opt-out, watchInactiveProjects and missing folders', async () => {
    const s = setup({
      projects: [
        project('a'),
        project('b', { settings: { git: { enabled: false } } }),
        project('c', { missing: true }),
      ],
      settings: { 'git.watchInactiveProjects': true },
    });
    await s.service.sync();
    expect(s.methods('git:watch').map((p) => (p as { projectId: string }).projectId)).toEqual(['a']);
    s.setSettings({ 'git.enabled': false });
    await s.service.sync();
    expect(s.methods('git:unwatch')).toEqual([{ projectId: 'a' }]);

    const only = setup({ settings: { 'git.watchInactiveProjects': false } });
    await only.service.sync();
    expect(only.methods('git:watch').map((p) => (p as { projectId: string }).projectId)).toEqual(['a']);
    only.setActive('b');
    await only.service.sync();
    expect(only.methods('git:watch').map((p) => (p as { projectId: string }).projectId)).toEqual(['a', 'b']);
    expect(only.methods('git:unwatch')).toEqual([{ projectId: 'a' }]);
    expect(only.methods('git:refresh')).toContainEqual({ projectId: 'b', reason: 'focus' });
  });

  it('reports git-missing repositories when git cannot run', async () => {
    const s = setup({ git: false });
    const infos: unknown[] = [];
    s.service.onDidChangeRepo((i) => infos.push(i));
    await s.service.sync();
    expect(s.methods('git:watch')).toEqual([]);
    expect(infos).toEqual([
      expect.objectContaining({ projectId: 'a', state: 'git-missing' }),
      expect.objectContaining({ projectId: 'b', state: 'git-missing' }),
    ]);
  });

  it('re-watches after a Workspace Host restart', async () => {
    const s = setup();
    await s.service.sync();
    s.restartHost();
    await s.service.sync();
    expect(s.methods('git:watch')).toHaveLength(4);
  });
});
