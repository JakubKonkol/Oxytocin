import { describe, expect, it } from 'vitest';
import { BODY_LIMITS, bodyTerms, searchTerms, stem, terms, tokens } from './terms';

describe('Code Map search terms', () => {
  it('splits camelCase, PascalCase, snake_case and acronyms, keeping repeats only in tokens', () => {
    expect(tokens('getPathForFile')).toEqual(['get', 'path', 'for', 'file']);
    expect(tokens('XMLHttpRequest find_user')).toEqual(['xml', 'http', 'request', 'find', 'user']);
    expect(tokens('ACKs and PTYs')).toEqual(['ack', 'and', 'pty']);
    expect(tokens('user user')).toEqual(['user', 'user']);
    expect(terms('user User')).toEqual(['user']);
  });
  it('folds plurals and tenses to one key without merging unrelated words', () => {
    expect(stem('files')).toBe(stem('file'));
    expect(stem('debounced')).toBe(stem('debounce'));
    expect(stem('debouncing')).toBe(stem('debounce'));
    expect(stem('stored')).toBe(stem('store'));
    expect(stem('mappings')).toBe(stem('map'));
    expect(stem('queries')).toBe(stem('query'));
    expect(stem('processes')).toBe(stem('process'));
    expect(stem('status')).toBe('status');
    expect(stem('string')).toBe('string');
    expect(stem('x1b')).toBe('x1b');
    expect(stem('cache')).not.toBe(stem('catch'));
    expect(stem(stem('files'))).toBe(stem('files'));
  });
  it('removes question words, maps configuration vocabulary and stems question terms', () => {
    expect(searchTerms('Where are the dropped files converted to paths?')).toEqual(['drop', 'file', 'convert', 'path']);
    expect(searchTerms('Gdzie w aplikacji mamy konfigurację code map')).toEqual(['config', 'code', 'map']);
    expect(searchTerms('How does the app check for updates?')).toEqual(['check', stem('update')]);
  });
  it('counts body terms without noise, with identifiers split and comments and strings included', () => {
    const { counts, total } = bodyTerms(
      [
        '// Debounced refresh of the git status',
        'export const refreshSchedulerDelay = 250; // a1b2',
        "return webUtils.getPathForFile(file) ?? 'x1b';",
      ].join('\n'),
    );
    expect(counts.get(stem('debounced'))).toBe(1);
    expect(counts.get('refresh')).toBe(2);
    expect(counts.get('path')).toBe(1);
    expect(counts.get('file')).toBe(2);
    for (const noise of ['the', 'of', 'const', 'return', 'export', '250', 'x']) expect(counts.has(noise)).toBe(false);
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(total);
  });
  it('bounds the number of distinct terms per document and ignores very long tokens', () => {
    const many = Array.from({ length: BODY_LIMITS.terms + 500 }, (_, i) => `term${i.toString(36)}zz`).join(' ');
    const { counts, total } = bodyTerms(`${many} ${'a'.repeat(BODY_LIMITS.tokenLength + 1)}`);
    expect(counts.size).toBe(BODY_LIMITS.terms);
    expect(total).toBe(BODY_LIMITS.terms + 500);
    // The most frequent terms survive the cut.
    const kept = bodyTerms(`${many} hotterm hotterm hotterm`);
    expect(kept.counts.get('hotterm')).toBe(3);
    expect(kept.counts.size).toBe(BODY_LIMITS.terms);
  });
});
