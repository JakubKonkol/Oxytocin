import { describe, expect, it } from 'vitest';
import { parseNumstat, parsePorcelainV2, type PorcelainRecord, statusVsHead } from './porcelain-v2';

const z = (...entries: string[]) => entries.map((e) => `${e}\0`).join('');
const H = '0'.repeat(40);

describe('porcelain v2 parser', () => {
  it('parses branch headers', () => {
    const { branch } = parsePorcelainV2(
      z(
        `# branch.oid ${'a'.repeat(40)}`,
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +2 -1',
      ),
    );
    expect(branch).toEqual({
      oid: 'a'.repeat(40),
      head: 'feature/x',
      detached: false,
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 1,
    });
    expect(parsePorcelainV2(z('# branch.oid (initial)', '# branch.head main')).branch).toEqual({
      head: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
    });
    expect(parsePorcelainV2(z(`# branch.oid ${H}`, '# branch.head (detached)')).branch).toMatchObject({
      head: null,
      detached: true,
    });
  });

  it('parses all record types including spaces, Unicode, renames and submodules', () => {
    const out = z(
      `1 .M N... 100644 100644 100644 ${H} ${H} src/with space.ts`,
      `1 A. N... 000000 100644 100644 ${H} ${H} zażółć gęślą.md`,
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts`,
      'old name.ts',
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.txt`,
      `1 .M SC.. 160000 160000 160000 ${H} ${H} vendor/lib`,
      '? untracked file.txt',
      '! ignored.log',
    );
    const { records } = parsePorcelainV2(out);
    expect(records).toEqual([
      { type: '1', xy: '.M', sub: 'N...', path: 'src/with space.ts' },
      { type: '1', xy: 'A.', sub: 'N...', path: 'zażółć gęślą.md' },
      { type: '2', xy: 'R.', sub: 'N...', score: 'R100', path: 'new name.ts', origPath: 'old name.ts' },
      { type: 'u', xy: 'UU', sub: 'N...', path: 'conflict.txt' },
      { type: '1', xy: '.M', sub: 'SC..', path: 'vendor/lib' },
      { type: '?', path: 'untracked file.txt' },
      { type: '!', path: 'ignored.log' },
    ]);
  });
});

describe('statusVsHead', () => {
  const r = (xy: string, type: '1' | '2' = '1'): PorcelainRecord =>
    type === '2'
      ? { type, xy, sub: 'N...', path: 'p', origPath: 'o', score: 'R100' }
      : { type, xy, sub: 'N...', path: 'p' };
  it.each([
    ['.M', 'modified'],
    ['M.', 'modified'],
    ['MM', 'modified'],
    ['A.', 'added'],
    ['AM', 'added'],
    ['AD', null],
    ['D.', 'deleted'],
    ['.D', 'deleted'],
    ['MD', 'deleted'],
    ['T.', 'typechange'],
    ['.T', 'typechange'],
    ['..', null],
  ])('%s → %s', (xy, expected) => {
    expect(statusVsHead(r(xy))).toBe(expected);
  });
  it('handles renames, conflicts and untracked files', () => {
    expect(statusVsHead(r('R.', '2'))).toBe('renamed');
    expect(statusVsHead(r('RM', '2'))).toBe('renamed');
    expect(statusVsHead({ type: 'u', xy: 'UU', sub: 'N...', path: 'p' })).toBe('conflicted');
    expect(statusVsHead({ type: '?', path: 'p' })).toBe('untracked');
    expect(statusVsHead({ type: '!', path: 'p' })).toBeNull();
  });
});

describe('numstat parser', () => {
  it('parses counts, binaries and -z renames', () => {
    const out = z('3\t1\tsrc/a.ts', '-\t-\timg.png', '5\t0\t', 'old.ts', 'new.ts', '0\t2\twith\ttab.txt');
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
      { path: 'img.png', additions: null, deletions: null, binary: true },
      { path: 'new.ts', oldPath: 'old.ts', additions: 5, deletions: 0, binary: false },
      { path: 'with\ttab.txt', additions: 0, deletions: 2, binary: false },
    ]);
  });
});
