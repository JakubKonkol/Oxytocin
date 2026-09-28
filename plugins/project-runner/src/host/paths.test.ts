import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromShellPath, pathCandidates } from './paths';

describe('paths', () => {
  it('converts Git Bash and WSL paths on Windows only', () => {
    expect(fromShellPath('/c/work/app', 'win32')).toBe('C:\\work\\app');
    expect(fromShellPath('/mnt/d/src', 'win32')).toBe('D:\\src');
    expect(fromShellPath('/c', 'win32')).toBe('C:\\');
    expect(fromShellPath('C:\\work', 'win32')).toBe('C:\\work');
    expect(fromShellPath('/c/work/app', 'linux')).toBe('/c/work/app');
  });

  it('adds the real path of symlinked folders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-paths-'));
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const candidates = await pathCandidates(join(dir, 'link'), 'linux');
    expect(candidates[0]).toBe(join(dir, 'link'));
    expect(candidates.at(-1)).toMatch(/real$/);
    expect(await pathCandidates('/definitely/missing', 'linux')).toEqual(['/definitely/missing']);
  });
});
