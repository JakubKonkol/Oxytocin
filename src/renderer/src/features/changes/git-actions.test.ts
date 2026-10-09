import { describe, expect, it } from 'vitest';
import { stageState } from './git-actions';
import { commitScope } from './CommitBox';

describe('git actions', () => {
  it('summarizes the staged state of a group of files', () => {
    const f = (staged: boolean, unstaged: boolean) => ({ staged, unstaged });
    expect(stageState([])).toBe('none');
    expect(stageState([f(true, false), f(true, false)])).toBe('all');
    expect(stageState([f(true, true)])).toBe('some');
    expect(stageState([f(true, false), f(false, true)])).toBe('some');
    expect(stageState([f(false, true)])).toBe('none');
  });

  it('commits the staged files, or everything when nothing is staged', () => {
    const file = (staged: boolean) => ({ path: 'a', status: 'modified' as const, staged, unstaged: !staged });
    expect(commitScope({ files: [file(true), file(false)] })).toEqual({ staged: 1, total: 2 });
    expect(commitScope({ files: [file(false)] })).toEqual({ staged: 0, total: 1 });
  });
});
