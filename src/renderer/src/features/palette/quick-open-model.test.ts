import { describe, expect, it } from 'vitest';
import type { FileChange } from '@shared/domain/git';
import type { Project } from '@shared/domain/project';
import type { TerminalInfo } from '@shared/domain/terminal';
import { buildItems, GROUPS, parseQuery, pickItems, type QuickOpenSources, rankItems } from './quick-open-model';

const project = (id: string, name: string): Project => ({
  id,
  name,
  rootPath: `/work/${name}`,
  color: 1,
  pinned: false,
  order: 0,
  createdAt: 0,
  settings: {},
});

const terminal = (id: string, projectId: string, title: string, createdAt: number): TerminalInfo =>
  ({ id, projectId, title, createdAt, kind: 'shell', state: 'running' }) as TerminalInfo;

const change = (path: string): FileChange => ({ path, status: 'modified', staged: false, unstaged: true });

const sources = (over: Partial<QuickOpenSources> = {}): QuickOpenSources => ({
  commands: [
    { id: 'terminal.new', title: 'Terminal: New Terminal' },
    { id: 'terminal.splitRight', title: 'Terminal: Split Right' },
    { id: 'workbench.toggleSidebar', title: 'View: Toggle Sidebar' },
  ],
  recentCommands: [],
  projects: [project('p1', 'alpha'), project('p2', 'beta')],
  activeProjectId: 'p1',
  terminals: [
    terminal('t1', 'p2', 'pwsh', 1),
    terminal('t2', 'p1', 'claude', 2),
    terminal('t3', 'p1', 'bash', 3),
    terminal('t4', 'gone', 'orphan', 4),
  ],
  changes: [change('src/app.ts'), change('README.md')],
  shortcutFor: (id) => (id === 'terminal.new' ? 'ctrl+shift+t' : undefined),
  ...over,
});

describe('parseQuery', () => {
  it('maps prefixes to modes', () => {
    expect(parseQuery('')).toEqual({ mode: 'all', text: '' });
    expect(parseQuery('>split')).toEqual({ mode: 'commands', text: 'split' });
    expect(parseQuery('@ claude')).toEqual({ mode: 'terminals', text: 'claude' });
    expect(parseQuery('#app')).toEqual({ mode: 'files', text: 'app' });
    expect(parseQuery(' alpha ')).toEqual({ mode: 'all', text: 'alpha' });
  });
});

describe('buildItems', () => {
  it('lists projects, terminals of known projects (active project first, newest first) and changed files', () => {
    const items = buildItems('all', sources());
    expect(items.map((i) => i.id)).toEqual([
      'project:p1',
      'project:p2',
      'terminal:t3',
      'terminal:t2',
      'terminal:t1',
      'file:src/app.ts',
      'file:README.md',
    ]);
    const file = items.find((i) => i.id === 'file:src/app.ts')!;
    expect(file).toMatchObject({ label: 'app.ts', detail: 'src', labelOffset: 4 });
    expect(file.action).toEqual({ kind: 'file', projectId: 'p1', path: 'src/app.ts' });
    expect(items.find((i) => i.id === 'project:p1')!.detail).toContain('active');
  });

  it('puts recently used commands first and shows keybindings', () => {
    const items = buildItems('commands', sources({ recentCommands: ['workbench.toggleSidebar'] }));
    expect(items.map((i) => [i.id, i.group])).toEqual([
      ['command:workbench.toggleSidebar', GROUPS.recent],
      ['command:terminal.new', GROUPS.otherCommands],
      ['command:terminal.splitRight', GROUPS.otherCommands],
    ]);
    expect(items[1]!.shortcut).toBe('ctrl+shift+t');
  });

  it('has no changed files without an active project', () => {
    expect(buildItems('files', sources({ activeProjectId: null }))).toEqual([]);
  });
});

describe('rankItems', () => {
  it('keeps the natural order without a query', () => {
    const items = buildItems('commands', sources({ recentCommands: ['terminal.splitRight'] }));
    expect(rankItems(items, '').map((i) => i.id)[0]).toBe('command:terminal.splitRight');
  });

  it('filters by score and merges command groups while searching', () => {
    const ranked = rankItems(buildItems('commands', sources({ recentCommands: ['terminal.new'] })), 'split');
    expect(ranked.map((i) => i.id)).toEqual(['command:terminal.splitRight']);
    expect(ranked[0]!.group).toBe(GROUPS.commands);
    expect(ranked[0]!.indices).toEqual([10, 11, 12, 13, 14]);
  });

  it('keeps group order and caps each group', () => {
    const many = sources({ changes: Array.from({ length: 80 }, (_, i) => change(`f${i}.ts`)) });
    const ranked = rankItems(buildItems('all', many), 'f');
    expect(ranked.filter((i) => i.group === GROUPS.files)).toHaveLength(50);
    expect(rankItems(buildItems('files', many), '', 10)).toHaveLength(10);
    const all = rankItems(buildItems('all', sources()), 'a');
    const groups = [...new Set(all.map((i) => i.group))];
    expect(groups).toEqual([GROUPS.projects, GROUPS.terminals, GROUPS.files]);
  });
});

describe('pickItems', () => {
  it('matches label and description and returns the item index', () => {
    const items = pickItems([{ label: 'README.md' }, { label: 'plan.md', description: 'docs', detail: 'Plan' }]);
    const ranked = rankItems(items, 'docs');
    expect(ranked.map((i) => i.action)).toEqual([{ kind: 'pick', index: 1 }]);
    expect(ranked[0]).toMatchObject({ detail: 'docs', subline: 'Plan' });
  });
});
