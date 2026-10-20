import { describe, expect, it } from 'vitest';
import { type CallerDeps, resolveCaller, resolveCodeMapCaller } from './caller-context';

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

describe('strict Code Map caller', () => {
  it('maps registered worktree paths and terminal cwd without falling back to the main checkout', async () => {
    const d = deps({
      platform: 'linux',
      realpath: (p) => Promise.resolve(p),
      projects: () => [{ id: 'p', name: 'App', rootPath: '/app' }],
      terminal: () => ({ id: 't', projectId: 'p', cwd: '/trees/a/src' }),
      checkouts: () => [
        { id: 'p', projectId: 'p', name: 'App', rootPath: '/app' },
        { id: 'worktree:a', projectId: 'p', name: 'A', rootPath: '/trees/a' },
      ],
    });
    expect((await resolveCodeMapCaller(d, { terminalHeader: 't', args: {} })).context).toMatchObject({
      projectId: 'p',
      checkoutId: 'worktree:a',
    });
    expect((await resolveCodeMapCaller(d, { args: { cwd: '/trees/a/src' } })).context).toEqual({
      projectId: 'p',
      checkoutId: 'worktree:a',
    });
    expect((await resolveCodeMapCaller(d, { terminalHeader: 't', args: { project: 'p' } })).projectError).toContain(
      'Conflicting',
    );
    d.checkouts = () => [];
    expect((await resolveCodeMapCaller(d, { terminalHeader: 't', args: {} })).context.projectId).toBeUndefined();
  });
  const strict = () => deps({ realpath: (path) => Promise.resolve(path) });
  it('never falls back to the active or only project, rejects conflicting and unknown selectors', async () => {
    expect((await resolveCodeMapCaller(strict(), { args: {} })).context.projectId).toBeUndefined();
    expect(
      (await resolveCodeMapCaller(strict(), { terminalHeader: 't-1', args: { cwd: 'C:\\work\\shop' } })).projectError,
    ).toContain('Conflicting');
    expect(
      (await resolveCodeMapCaller(strict(), { args: { cwd: 'C:\\unknown', project: 'Shop' } })).context.projectId,
    ).toBeUndefined();
    expect(
      (await resolveCodeMapCaller(strict(), { args: { cwd: 'C:\\work\\shop', project: 'Api' } })).projectError,
    ).toContain('Conflicting');
    expect((await resolveCodeMapCaller(strict(), { args: { project: 'Api' } })).context.projectId).toBe('p2');
  });
  it('canonicalizes paths before selection and selects the longest registered containing root', async () => {
    const nested = { id: 'nested', name: 'Nested', rootPath: 'C:\\work\\shop\\nested' };
    const d = strict();
    d.findByPath = (path) =>
      [...projects, nested]
        .filter((p) => path === p.rootPath || path.startsWith(`${p.rootPath}\\`))
        .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    d.projects = () => [...projects, nested];
    expect((await resolveCodeMapCaller(d, { args: { cwd: `${nested.rootPath}\\src` } })).context.projectId).toBe(
      'nested',
    );
    d.realpath = () => Promise.resolve('C:\\outside');
    expect(
      (await resolveCodeMapCaller(d, { args: { cwd: 'C:\\work\\shop\\link' } })).context.projectId,
    ).toBeUndefined();
  });
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
