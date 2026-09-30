import { describe, expect, it } from 'vitest';
import { type CallerDeps, resolveCaller } from './caller-context';

const projects = [
  { id: 'p1', name: 'Shop', rootPath: 'C:\\work\\shop' },
  { id: 'p2', name: 'Api', rootPath: 'C:\\work\\api' },
];

const deps = (over: Partial<CallerDeps> = {}): CallerDeps => ({
  terminal: (id) => (id === 't-1' ? { id: 't-1', projectId: 'p2', agentId: 'claude' } : undefined),
  projects: () => projects,
  activeProjectId: () => 'p1',
  findByPath: (path) => projects.find((p) => path.toLowerCase().startsWith(p.rootPath.toLowerCase())),
  realpath: (path) => Promise.resolve(path === 'C:\\short\\SHOP~1' ? 'C:\\work\\shop' : null),
  platform: 'win32',
  ...over,
});

describe('resolveCaller', () => {
  it('prefers an explicit project, then the terminal header, then cwd, then the active project', async () => {
    expect((await resolveCaller(deps(), { terminalHeader: 't-1', args: { project: 'shop' } })).context).toEqual({
      terminalId: 't-1',
      agentId: 'claude',
      projectId: 'p1',
    });
    expect((await resolveCaller(deps(), { terminalHeader: 't-1', args: { cwd: 'C:\\work\\shop' } })).context).toEqual({
      terminalId: 't-1',
      agentId: 'claude',
      projectId: 'p2',
    });
    expect((await resolveCaller(deps(), { args: { cwd: '/c/work/api/src' } })).context).toEqual({ projectId: 'p2' });
    expect((await resolveCaller(deps(), { args: { cwd: 'C:\\short\\SHOP~1' } })).context.projectId).toBe('p1');
    expect((await resolveCaller(deps(), { args: {} })).context).toEqual({ projectId: 'p1' });
  });

  it('ignores a header that names no terminal (a literal or the default of an unset variable)', async () => {
    for (const header of ['${OXYTOCIN_TERMINAL_ID}', 'none', ''])
      expect((await resolveCaller(deps(), { terminalHeader: header, args: {} })).context).toEqual({ projectId: 'p1' });
  });

  it('explains an explicit project or cwd that matches nothing', async () => {
    const r = await resolveCaller(deps(), { args: { project: 'nope' } });
    expect(r.context.projectId).toBeUndefined();
    expect(r.projectError).toMatch(/No open project "nope". Open projects: Shop/);
    const c = await resolveCaller(deps(), { args: { cwd: 'D:\\elsewhere' } });
    expect(c.projectError).toMatch(/not inside a project/);
  });

  it('falls back to the only project, else leaves the project open', async () => {
    const one = deps({ activeProjectId: () => null, projects: () => [projects[0]!] });
    expect((await resolveCaller(one, { args: {} })).context.projectId).toBe('p1');
    const none = deps({ activeProjectId: () => null });
    expect((await resolveCaller(none, { args: {} })).context).toEqual({});
  });
});
