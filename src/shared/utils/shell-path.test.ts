import { describe, expect, it } from 'vitest';
import { fromShellPath, isAbsolutePath } from './shell-path';

describe('fromShellPath', () => {
  it('converts Git Bash, Cygwin and WSL paths on Windows', () => {
    expect(fromShellPath('/c/work/app', 'win32')).toBe('C:\\work\\app');
    expect(fromShellPath('/mnt/d/x', 'win32')).toBe('D:\\x');
    expect(fromShellPath('/cygdrive/e', 'win32')).toBe('E:\\');
    expect(fromShellPath('C:\\work', 'win32')).toBe('C:\\work');
  });

  it('leaves other platforms alone', () => {
    expect(fromShellPath('/c/work', 'linux')).toBe('/c/work');
  });

  it('tells absolute paths', () => {
    expect(isAbsolutePath('C:\\x', 'win32')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share', 'win32')).toBe(true);
    expect(isAbsolutePath('app', 'win32')).toBe(false);
    expect(isAbsolutePath('/home/x', 'darwin')).toBe(true);
  });
});
