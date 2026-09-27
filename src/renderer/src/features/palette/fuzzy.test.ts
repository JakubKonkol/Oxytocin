import { describe, expect, it } from 'vitest';
import { fuzzyMatch, highlightRuns } from './fuzzy';

const score = (text: string, q: string) => fuzzyMatch(text, q)?.score ?? -Infinity;

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively and ignores spaces in the query', () => {
    expect(fuzzyMatch('Terminal: Split Right', 'term split')).not.toBeNull();
    expect(fuzzyMatch('Terminal: Split Right', 'TSR')).not.toBeNull();
    expect(fuzzyMatch('Terminal: Split Right', 'xyz')).toBeNull();
    expect(fuzzyMatch('abc', 'abcd')).toBeNull();
    expect(fuzzyMatch('anything', '')).toEqual({ score: 0, indices: [] });
  });

  it('prefers word starts and contiguous runs', () => {
    expect(fuzzyMatch('Terminal: Split Right', 'sr')!.indices).toEqual([10, 16]);
    expect(score('View: Toggle Sidebar', 'sidebar')).toBeGreaterThan(score('View: Focus Changes', 'sidebar'));
    expect(score('src/app.ts', 'app')).toBeGreaterThan(score('src/wrapper.ts', 'app'));
    expect(fuzzyMatch('src/wrapper/app.ts', 'app')!.indices).toEqual([12, 13, 14]);
  });

  it('ranks shorter texts first on otherwise equal matches', () => {
    expect(score('Terminal: New Terminal', 'new terminal')).toBeGreaterThan(
      score('Terminal: New Terminal With Profile…', 'new terminal'),
    );
  });

  it('matches camelCase boundaries as word starts', () => {
    expect(fuzzyMatch('splitRight', 'sr')!.indices).toEqual([0, 5]);
  });
});

describe('highlightRuns', () => {
  it('splits a label into plain and highlighted runs, honouring the label offset', () => {
    expect(highlightRuns('app.ts', [4, 5, 6], 4)).toEqual([
      { text: 'app', hit: true },
      { text: '.ts', hit: false },
    ]);
    expect(highlightRuns('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});
