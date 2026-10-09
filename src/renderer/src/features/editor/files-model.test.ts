import { describe, expect, it } from 'vitest';
import { cleanName } from './file-ops';
import { flattenFiles, statusIndex } from './files-model';
import { ancestors, dirsToReload } from './files-store';

describe('files model', () => {
  const dirs = {
    '': {
      entries: [
        { name: 'src', kind: 'dir' as const },
        { name: 'dist', kind: 'dir' as const, ignored: true },
        { name: 'README.md', kind: 'file' as const },
      ],
    },
    src: { entries: [{ name: 'a.ts', kind: 'file' as const }] },
    dist: { error: 'EACCES' },
  };

  it('flattens expanded folders depth first and notes folders that are loading or unreadable', () => {
    expect(flattenFiles(dirs, new Set()).map((r) => `${r.depth}:${r.path}`)).toEqual([
      '0:src',
      '0:dist',
      '0:README.md',
    ]);
    const rows = flattenFiles(dirs, new Set(['src', 'dist']));
    expect(rows.map((r) => `${r.depth}:${r.path}${r.note ? `:${r.note}` : ''}`)).toEqual([
      '0:src',
      '1:src/a.ts',
      '0:dist',
      '1:dist/!:error',
      '0:README.md',
    ]);
    expect(rows.find((r) => r.path === 'dist')?.ignored).toBe(true);
    expect(flattenFiles({ '': dirs[''] }, new Set(['src'])).find((r) => r.note)?.note).toBe('loading');
  });

  it('indexes git statuses of files and the most severe one of their folders', () => {
    const index = statusIndex([
      { path: 'src/a.ts', status: 'untracked' },
      { path: 'src/deep/b.ts', status: 'deleted' },
    ]);
    expect(index.get('src/a.ts')).toBe('untracked');
    expect(index.get('src')).toBe('deleted');
    expect(index.get('src/deep')).toBe('deleted');
  });

  it('reloads the loaded parent folders of touched paths', () => {
    expect(dirsToReload(['', 'src'], ['src/a.ts', 'new.txt', 'other/x.ts'])).toEqual(['src', '']);
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
  });

  it('turns typed names into relative paths', () => {
    expect(cleanName(' src\\\\utils/ x.ts ')).toBe('src/utils/x.ts');
    expect(cleanName('../x')).toBeNull();
    expect(cleanName('a:b')).toBeNull();
    expect(cleanName('  ')).toBeNull();
  });
});
