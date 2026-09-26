import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateProjectsFile, type ProjectFs, ProjectService } from './project-service';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'oxy-projects-')));
  await mkdir(join(dir, 'home', 'api', 'packages', 'core'), { recursive: true });
  await mkdir(join(dir, 'home', 'web'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const realFs: ProjectFs = {
  realpath: (p) => realpath(p),
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
};

let ids = 0;
const make = (over: Partial<ConstructorParameters<typeof ProjectService>[0]> = {}) =>
  new ProjectService({
    file: join(dir, 'projects.json'),
    fs: realFs,
    platform: 'linux',
    homeDir: join(dir, 'home'),
    logger,
    newId: () => `p${++ids}`,
    ...over,
  });

describe('ProjectService', () => {
  it('adds a folder, names it after the folder and activates it', async () => {
    const svc = make();
    await svc.load();
    const result = await svc.add(join(dir, 'home', 'api') + '/');
    expect(result.existed).toBe(false);
    expect(result.project).toMatchObject({ name: 'api', rootPath: join(dir, 'home', 'api'), pinned: false });
    expect(svc.activeProjectId).toBe(result.project.id);
    await svc.flush();
    const saved = JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8')) as { projects: unknown[] };
    expect(saved.projects).toHaveLength(1);
  });

  it('deduplicates and activates the existing project', async () => {
    const svc = make();
    const a = await svc.add(join(dir, 'home', 'api'));
    await svc.add(join(dir, 'home', 'web'));
    const again = await svc.add(join(dir, 'home', 'api', '.'));
    expect(again).toMatchObject({ existed: true, project: { id: a.project.id } });
    expect(svc.activeProjectId).toBe(a.project.id);
    expect(svc.list()).toHaveLength(2);
  });

  it('deduplicates case-insensitively on Windows-like platforms', async () => {
    const fakeFs: ProjectFs = { realpath: (p) => Promise.resolve(p), isDirectory: () => Promise.resolve(true) };
    const svc = make({ platform: 'win32', fs: fakeFs, homeDir: 'C:\\Users\\me' });
    const a = await svc.add('C:\\Dev\\Api');
    const b = await svc.add('c:\\dev\\api\\');
    expect(b).toMatchObject({ existed: true, project: { id: a.project.id } });
  });

  it('warns about nested projects and finds the longest matching root', async () => {
    const svc = make();
    const api = await svc.add(join(dir, 'home', 'api'));
    const core = await svc.add(join(dir, 'home', 'api', 'packages', 'core'));
    expect(core.warning).toBe('Project ‘api’ contains this folder');
    expect(svc.findByPath(join(dir, 'home', 'api', 'packages', 'core', 'src'))?.id).toBe(core.project.id);
    expect(svc.findByPath(join(dir, 'home', 'api', 'README.md'))?.id).toBe(api.project.id);
    expect(svc.findByPath(join(dir, 'elsewhere'))).toBeUndefined();
  });

  it('rejects missing folders, drive roots and the home folder', async () => {
    const svc = make();
    await expect(svc.add(join(dir, 'nope'))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(svc.add('/')).rejects.toThrow('not a whole drive');
    await expect(svc.add(join(dir, 'home'))).rejects.toThrow('home folder');
  });

  it('flags missing folders at runtime without persisting the flag', async () => {
    const svc = make();
    const { project } = await svc.add(join(dir, 'home', 'web'));
    await rm(join(dir, 'home', 'web'), { recursive: true });
    await svc.refreshMissing();
    expect(svc.get(project.id)?.missing).toBe(true);
    await mkdir(join(dir, 'other'));
    const located = await svc.update({ id: project.id, rootPath: join(dir, 'other') });
    expect(located.missing).toBeUndefined();
    expect(located.rootPath).toBe(join(dir, 'other'));
    await svc.flush();
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).not.toContain('missing');
  });

  it('orders pinned projects first and reorders', async () => {
    const svc = make();
    const a = await svc.add(join(dir, 'home', 'api'));
    const b = await svc.add(join(dir, 'home', 'web'));
    svc.reorder([b.project.id, a.project.id]);
    expect(svc.list().map((p) => p.name)).toEqual(['web', 'api']);
    await svc.update({ id: a.project.id, pinned: true });
    expect(svc.list().map((p) => p.name)).toEqual(['api', 'web']);
  });

  it('removing the active project activates the next one', async () => {
    const svc = make();
    const a = await svc.add(join(dir, 'home', 'api'));
    const b = await svc.add(join(dir, 'home', 'web'));
    svc.remove(b.project.id);
    expect(svc.activeProjectId).toBe(a.project.id);
    expect(svc.list()).toHaveLength(1);
  });
});

describe('migrateProjectsFile', () => {
  it('adds a version to unversioned files', () => {
    expect(migrateProjectsFile({ projects: [] })).toEqual({ version: 1, activeProjectId: null, projects: [] });
  });
});
