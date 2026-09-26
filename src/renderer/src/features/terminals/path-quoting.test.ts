import { describe, expect, it } from 'vitest';
import { formatDroppedPaths, quotePathForShell, windowsToPosixPath } from './path-quoting';

describe('quotePathForShell', () => {
  it('quotes for PowerShell with doubled apostrophes', () => {
    expect(quotePathForShell('C:\\a b\\c.png', 'pwsh')).toBe("'C:\\a b\\c.png'");
    expect(quotePathForShell("C:\\it's\\x.txt", 'powershell')).toBe("'C:\\it''s\\x.txt'");
    expect(quotePathForShell('C:\\plain\\x.txt', 'pwsh')).toBe('C:\\plain\\x.txt');
  });

  it('quotes for cmd with double quotes', () => {
    expect(quotePathForShell('C:\\a b\\c.png', 'cmd')).toBe('"C:\\a b\\c.png"');
    expect(quotePathForShell('C:\\x&y\\z', 'cmd')).toBe('"C:\\x&y\\z"');
    expect(quotePathForShell('C:\\plain\\x', 'cmd')).toBe('C:\\plain\\x');
  });

  it('converts and quotes for Git Bash and WSL', () => {
    expect(quotePathForShell('C:\\a b\\c.png', 'git-bash')).toBe("'/c/a b/c.png'");
    expect(quotePathForShell('D:\\src\\x.ts', 'wsl')).toBe('/mnt/d/src/x.ts');
    expect(windowsToPosixPath('C:\\', 'git-bash')).toBe('/c/');
  });

  it('quotes POSIX paths only when needed', () => {
    expect(quotePathForShell('/home/me/x.png', 'bash')).toBe('/home/me/x.png');
    expect(quotePathForShell("/home/me/it's here.png", 'zsh')).toBe("'/home/me/it'\\''s here.png'");
  });

  it('joins several paths', () => {
    expect(formatDroppedPaths(['/a', '/b c'], 'fish')).toBe("/a '/b c' ");
    expect(formatDroppedPaths([], 'bash')).toBe('');
  });
});
