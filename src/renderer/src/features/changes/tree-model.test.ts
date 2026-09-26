import { describe, expect, it } from 'vitest';
import type { ChangeStatus, FileChange } from '@shared/domain/git';
import { allDirPaths, buildTree, type DirNode, flattenList, flattenTree, parentRowIndex } from './tree-model';

const f = (path: string, status: ChangeStatus = 'modified', extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status,
  staged: false,
  unstaged: true,
  ...extra,
});

const names = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.node.name}`);

describe('changes tree model', () => {
  const files = [
    f('src/features/terminals/TerminalView.tsx'),
    f('src/features/terminals/pty.ts', 'added'),
    f('src/main/index.ts', 'deleted'),
    f('README.md', 'untracked'),
    f('docs/a.md', 'conflicted'),
    f('Zeta.txt'),
  ];

  it('builds a sorted tree with compacted folder chains and aggregated statuses', () => {
    const tree = buildTree(files);
    expect(names(flattenTree(tree, null))).toEqual([
      'docs',
      '  a.md',
      'src',
      '  features/terminals',
      '    pty.ts',
      '    TerminalView.tsx',
      '  main',
      '    index.ts',
      'README.md',
      'Zeta.txt',
    ]);
    const src = tree.find((n) => n.name === 'src') as DirNode;
    expect(src).toMatchObject({ fileCount: 3, status: 'deleted' });
    expect((src.children[0] as DirNode).path).toBe('src/features/terminals');
    expect((tree[0] as DirNode).status).toBe('conflicted');
    expect(allDirPaths(tree)).toEqual(['docs', 'src', 'src/features/terminals', 'src/main']);
  });

  it('collapses folders and filters files', () => {
    const tree = buildTree(files);
    expect(names(flattenTree(tree, new Set(['src'])))).toEqual([
      'docs',
      'src',
      '  features/terminals',
      '  main',
      'README.md',
      'Zeta.txt',
    ]);
    expect(names(flattenTree(tree, new Set(), 'PTY'))).toEqual(['src', '  features/terminals', '    pty.ts']);
    expect(flattenTree(tree, null, 'nothing-matches')).toEqual([]);
  });

  it('propagates the latest touch to folders', () => {
    const tree = buildTree([f('a/b.ts', 'modified', { touchedAt: 5 }), f('a/c.ts', 'modified', { touchedAt: 9 })]);
    expect((tree[0] as DirNode).touchedAt).toBe(9);
  });

  it('lists files with their folders in list mode', () => {
    const rows = flattenList(files, 'src/');
    expect(rows.map((r) => (r.node.kind === 'file' ? `${r.node.name} · ${r.node.dir}` : ''))).toEqual([
      'pty.ts · src/features/terminals',
      'TerminalView.tsx · src/features/terminals',
      'index.ts · src/main',
    ]);
  });

  it('finds the parent row for keyboard navigation', () => {
    const rows = flattenTree(buildTree(files), null);
    const index = rows.findIndex((r) => r.node.name === 'pty.ts');
    expect(rows[parentRowIndex(rows, index)]!.node.name).toBe('features/terminals');
    expect(parentRowIndex(rows, 0)).toBe(-1);
  });
});
