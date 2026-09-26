import { describe, expect, it } from 'vitest';
import { findFileLinks } from './file-links';

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
});
