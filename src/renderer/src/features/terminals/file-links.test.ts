import { describe, expect, it } from 'vitest';
import { fileUriToPath, findFileLinks, isInsideRoot } from './file-links';

describe('findFileLinks', () => {
  it('finds paths with line and column', () => {
    expect(findFileLinks('src/app.ts:12:3 - error TS2322')).toEqual([
      { start: 0, length: 15, path: 'src/app.ts', line: 12, column: 3 },
    ]);
    expect(findFileLinks('see package.json:1.')).toEqual([{ start: 4, length: 14, path: 'package.json', line: 1 }]);
  });

  it('handles Windows paths and stack traces', () => {
    expect(findFileLinks('    at run (C:\\work\\api\\index.js:10:5)')).toEqual([
      { start: 12, length: 25, path: 'C:\\work\\api\\index.js', line: 10, column: 5 },
    ]);
  });

  it('handles the file(line,col) format', () => {
    expect(findFileLinks('src/a.tsx(5,10): error')).toEqual([
      { start: 0, length: 15, path: 'src/a.tsx', line: 5, column: 10 },
    ]);
  });

  it('ignores URLs, versions and words without extensions', () => {
    expect(findFileLinks('https://example.com/a.js v1.2.3 README done.')).toEqual([]);
  });

  it('treats typographic quotes as separators', () => {
    expect(findFileLinks('Dopisałem to do sekcji „Atrybuty OT” w CLAUDE.md: gotowe')).toEqual([
      { start: 39, length: 9, path: 'CLAUDE.md' },
    ]);
    expect(findFileLinks('see „docs/plan.md” and “a.ts”')).toEqual([
      { start: 5, length: 12, path: 'docs/plan.md' },
      { start: 24, length: 4, path: 'a.ts' },
    ]);
  });
});

describe('fileUriToPath', () => {
  it('converts file URIs of OSC 8 hyperlinks', () => {
    expect(fileUriToPath('file:///home/me/app/CLAUDE.md')).toEqual({ path: '/home/me/app/CLAUDE.md' });
    expect(fileUriToPath('file:///C:/work/My%20App/a.ts#L12')).toEqual({ path: 'C:/work/My App/a.ts', line: 12 });
    expect(fileUriToPath('file://server/share/a.ts')).toEqual({ path: '//server/share/a.ts' });
    expect(fileUriToPath('https://example.com/a.ts')).toBeNull();
    expect(fileUriToPath('not a uri')).toBeNull();
  });
});

describe('isInsideRoot', () => {
  it('compares normalized paths', () => {
    expect(isInsideRoot('/p/app', '/p/app/src/a.ts', false)).toBe(true);
    expect(isInsideRoot('/p/app/', '/p/app', false)).toBe(true);
    expect(isInsideRoot('/p/app', '/p/apple/a.ts', false)).toBe(false);
    expect(isInsideRoot('C:\\Work\\App', 'c:/work/app/README.md', true)).toBe(true);
    expect(isInsideRoot('C:\\Work\\App', 'c:/work/app/README.md', false)).toBe(false);
  });
});
