import { describe, expect, it, vi } from 'vitest';
import type { CodeMapQueryData } from '@shared/domain/code-map-query';
import { fileRecord, normalizedSource } from '../extract/files';
import { sha256 } from '../store/writer';
import { attachExcerpts, cutLine, EXCERPT_LIMITS, selectExcerpt, type ExcerptSources } from './excerpt';
import { searchTerms } from './terms';

type Match = Extract<CodeMapQueryData, { kind: 'search' }>['matches'][number];
const terms = (question: string) => new Set(searchTerms(question));
const numbered = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const shown = (excerpt: { segments: { start: number; lines: string[] }[] }) =>
  excerpt.segments.flatMap((s) => s.lines.map((_, i) => s.start + i));

describe('selectExcerpt', () => {
  it('shows the signature line and the term lines with two lines of context, merged', () => {
    const lines = numbered(40);
    lines[9] = 'const shiftHandled = true;';
    lines[11] = 'sendRaw(newline);';
    lines[30] = 'unrelated shift newline';
    const excerpt = selectExcerpt(lines, { from: 1, to: 40 }, terms('shift newline'), 20, true)!;
    // Lines 10 and 12 share context and merge; 31 is a second run; the signature line 1 stands alone.
    expect(excerpt.segments.map((s) => [s.start, s.lines.length])).toEqual([
      [1, 1],
      [8, 7],
      [29, 5],
    ]);
    expect(excerpt.segments[1]!.lines[2]).toBe('const shiftHandled = true;');
    expect(excerpt.omitted).toBe(40 - 13);
  });

  it('uses the same stemming as ranking, so "debounced" finds "debounce" and "files" finds "file"', () => {
    const lines = ['function run() {', '  const debounce = 1;', '  openFile(path);', '}'];
    const excerpt = selectExcerpt(lines, { from: 1, to: 4 }, terms('debounced files'), 12, true)!;
    expect(shown(excerpt)).toEqual([1, 2, 3, 4]);
    expect(excerpt.omitted).toBe(0);
  });

  it('prefers lines with more and rarer terms when the cap is small, and never exceeds it', () => {
    const lines = numbered(100);
    lines[20] = 'alpha';
    lines[40] = 'alpha beta gamma';
    lines[60] = 'alpha';
    const excerpt = selectExcerpt(lines, { from: 1, to: 100 }, terms('alpha beta gamma'), 6, true)!;
    expect(shown(excerpt)).toContain(41);
    expect(shown(excerpt)).toHaveLength(6);
    expect(shown(excerpt)).not.toContain(21);
  });

  it('falls back to less context and skips what does not fit, within 12 lines by default', () => {
    const lines = numbered(200);
    for (const i of [20, 50, 80, 110, 140, 170]) lines[i] = 'needle in the line';
    const excerpt = selectExcerpt(lines, { from: 1, to: 200 }, terms('needle'), EXCERPT_LIMITS.hitLines, true)!;
    expect(shown(excerpt).length).toBeLessThanOrEqual(12);
    expect(shown(excerpt).length).toBe(12);
    expect(shown(excerpt)[0]).toBe(1);
    expect(excerpt.omitted).toBe(200 - 12);
  });

  it('shows only the signature line when no term occurs in the definition', () => {
    const lines = ['function nameOnly(a: string) {', '  return a;', '}'];
    const excerpt = selectExcerpt(lines, { from: 1, to: 3 }, terms('nothing matches'), 12, true)!;
    expect(excerpt).toEqual({ segments: [{ start: 1, lines: ['function nameOnly(a: string) {'] }], omitted: 2 });
  });

  it('stays inside the definition and numbers lines from the file', () => {
    const lines = numbered(30);
    lines[19] = 'target here';
    lines[10] = 'target before the span';
    const excerpt = selectExcerpt(lines, { from: 15, to: 25 }, terms('target'), 12, true)!;
    expect(Math.min(...shown(excerpt))).toBe(15);
    expect(Math.max(...shown(excerpt))).toBe(22);
    expect(shown(excerpt)).not.toContain(11);
  });

  it('gives a file hit no excerpt without term lines, and no signature line', () => {
    const lines = ['import x from "y";', ...numbered(20), 'export const cfg = flag;'];
    expect(selectExcerpt(lines, { from: 1, to: lines.length }, terms('nothing'), 12, false)).toBeUndefined();
    const found = selectExcerpt(lines, { from: 1, to: lines.length }, terms('flag'), 12, false)!;
    expect(shown(found)).toEqual([20, 21, 22]);
  });

  it('cuts long lines at 160 characters without splitting a surrogate pair, and removes control characters', () => {
    const long = `${'x'.repeat(158)}😀 and more`;
    const cut = cutLine(long);
    expect(cut).toHaveLength(159);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/);
    const plain = cutLine(`${'y'.repeat(200)}`);
    expect(plain).toHaveLength(160);
    expect(cutLine(['a\tb', '\u001b[31m', '\u2028', 'c', '\u202e', 'd  '].join(''))).toBe('a  b [31m cd');
    expect(cutLine('żółć 日本語 😀')).toBe('żółć 日本語 😀');
  });
});

/** A file on "disk" and the graph's record of it. */
function sources(files: Record<string, string>, indexed: Record<string, string> = files) {
  const read = vi.fn(async (path: string) => files[path] ?? Promise.reject(new Error('ENOENT')));
  const stale = new Set<string>();
  const api: ExcerptSources = {
    file: (path) => {
      const source = indexed[path];
      return source === undefined
        ? undefined
        : { sha256: fileRecord(path, source).file.sha256, bytes: Buffer.byteLength(source), stale: stale.has(path) };
    },
    read,
  };
  return { api, read, stale };
}
const hit = (path: string, span: Match['span'], extra: Partial<Match> = {}): Match => ({
  id: `s:${path}#${span?.[0]}`,
  path,
  name: 'name',
  kind: span ? 'function' : 'file',
  ...(span ? { span, signature: 'function name()' } : {}),
  stale: false,
  score: 1,
  whyIncluded: [],
  ...extra,
});
const body = (name: string, inner: string[]) => [`export function ${name}() {`, ...inner, '}', ''].join('\n');
const run = (matches: Match[], files: ReturnType<typeof sources>, query: string, extra = {}) =>
  attachExcerpts({ matches, query, mode: 'terms', budget: 100_000, sources: files.api, ...extra });

describe('attachExcerpts', () => {
  const source = body('handleKey', ['  if (shiftKey) {', '    sendNewline();', '  }']);
  const one = hit('a.ts', [1, 0, 5, 1]);

  it('attaches a verified excerpt to the best matches only', async () => {
    const files = sources({ 'a.ts': source, 'b.ts': source, 'c.ts': source, 'd.ts': source });
    const found = await run(
      ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => hit(p, [1, 0, 5, 1])),
      files,
      'shift newline',
    );
    expect(found.map((m) => !!m.excerpt)).toEqual([true, true, true, false]);
    expect(found[0]!.excerpt!.segments[0]!.lines[0]).toBe('export function handleKey() {');
    expect(files.read).toHaveBeenCalledTimes(3);
  });

  it('attaches nothing when the file changed after indexing, is unreadable, stale, or too large', async () => {
    const changed = sources({ 'a.ts': `${source}// edited\n` }, { 'a.ts': source });
    expect((await run([one], changed, 'shift'))[0]!.excerpt).toBeUndefined();
    const missing = sources({}, { 'a.ts': source });
    expect((await run([one], missing, 'shift'))[0]!.excerpt).toBeUndefined();
    const stale = sources({ 'a.ts': source });
    stale.stale.add('a.ts');
    expect((await run([one], stale, 'shift'))[0]!.excerpt).toBeUndefined();
    expect(
      (await run([hit('a.ts', [1, 0, 5, 1], { stale: true })], sources({ 'a.ts': source }), 'shift'))[0],
    ).not.toHaveProperty('excerpt');
    const big = sources({ 'a.ts': source });
    const file = big.api.file.bind(big.api);
    big.api.file = (path) => ({ ...file(path)!, bytes: EXCERPT_LIMITS.maxBytes + 1 });
    expect((await run([one], big, 'shift'))[0]!.excerpt).toBeUndefined();
    expect(big.read).not.toHaveBeenCalled();
  });

  it('skips a span that is outside the current file but keeps the other matches', async () => {
    const files = sources({ 'a.ts': source, 'b.ts': source });
    const found = await run([hit('a.ts', [1, 0, 99, 1]), hit('b.ts', [1, 0, 5, 1])], files, 'shift');
    expect(found.map((m) => !!m.excerpt)).toEqual([false, true]);
  });

  it('hashes normalized text: CRLF and BOM files verify and show clean lines', async () => {
    const raw = `\ufeff${source.replaceAll('\n', '\r\n')}`;
    const files = sources({ 'a.ts': raw }, { 'a.ts': normalizedSource(raw) });
    expect(sha256(normalizedSource(raw))).toBe(files.api.file('a.ts')!.sha256);
    const found = await run([one], files, 'shift');
    expect(found[0]!.excerpt!.segments[0]!.lines.every((l) => !l.includes('\r') && !l.includes('\ufeff'))).toBe(true);
    expect(found[0]!.excerpt!.segments[0]!.lines[0]).toBe('export function handleKey() {');
  });

  it('counts multibyte text by lines and keeps it intact', async () => {
    const text = body('wiadomość', ['  const żółć = "日本語 😀";', '  return żółć;']);
    const files = sources({ 'u.ts': text });
    const found = await run([hit('u.ts', [1, 0, 4, 1])], files, 'żółć');
    const lines = found[0]!.excerpt!.segments.flatMap((s) => s.lines);
    expect(lines).toContain('  const żółć = "日本語 😀";');
  });

  it('gives a file hit its term lines, and nothing when the file has none', async () => {
    const files = sources({ 'a.md': '# Title\nplain\nthe flag is documented here\nend\n' });
    const found = await run([hit('a.md', undefined, { kind: 'file' })], files, 'flag');
    expect(found[0]!.excerpt!.segments[0]!.start).toBe(1);
    expect(found[0]!.excerpt!.segments.flatMap((s) => s.lines)).toContain('the flag is documented here');
    expect((await run([hit('a.md', undefined, { kind: 'file' })], files, 'unmatched'))[0]!.excerpt).toBeUndefined();
  });

  it('caps an answer at 40 lines and skips excerpts that no longer fit', async () => {
    const wide = body(
      'wide',
      Array.from({ length: 60 }, (_, i) => `  needle${i % 2 ? 'a' : 'b'} needle`),
    );
    const files = sources({ 'a.ts': wide, 'b.ts': wide, 'c.ts': wide });
    const found = await run(
      ['a.ts', 'b.ts', 'c.ts'].map((p) => hit(p, [1, 0, 62, 1])),
      files,
      'needle',
    );
    const total = found.reduce((sum, m) => sum + shown(m.excerpt!).length, 0);
    expect(total).toBeLessThanOrEqual(EXCERPT_LIMITS.answerLines);
    for (const m of found) expect(shown(m.excerpt!).length).toBeLessThanOrEqual(EXCERPT_LIMITS.hitLines);
  });

  it('stops adding excerpts once the character budget is used, in rank order', async () => {
    const files = sources({ 'a.ts': source, 'b.ts': source, 'c.ts': source });
    const matches = ['a.ts', 'b.ts', 'c.ts'].map((p) => hit(p, [1, 0, 5, 1]));
    const first = (await run(matches, files, 'shift', { budget: 100_000 }))[0]!.excerpt!;
    const cost = JSON.stringify(first).length + 11;
    const found = await run(matches, files, 'shift', { budget: cost * 2 + 5 });
    expect(found.map((m) => !!m.excerpt)).toEqual([true, true, false]);
    expect((await run(matches, files, 'shift', { budget: cost - 1 })).some((m) => m.excerpt)).toBe(false);
  });

  it('returns the whole first definition up to 80 lines for full', async () => {
    const long = body(
      'long',
      Array.from({ length: 100 }, (_, i) => `  step${i}();`),
    );
    const files = sources({ 'a.ts': long, 'b.ts': source });
    const found = await attachExcerpts({
      matches: [hit('a.ts', [1, 0, 102, 1]), hit('b.ts', [1, 0, 5, 1])],
      query: 'step',
      mode: 'full',
      budget: 100_000,
      sources: files.api,
    });
    expect(found[0]!.excerpt!.segments).toHaveLength(1);
    expect(found[0]!.excerpt!.segments[0]!.lines).toHaveLength(80);
    expect(found[0]!.excerpt!.omitted).toBe(22);
    // Only the first definition is expanded.
    expect(found[1]!.excerpt).toBeUndefined();
    const short = await attachExcerpts({
      matches: [hit('b.ts', [1, 0, 5, 1])],
      query: 'x',
      mode: 'full',
      budget: 100_000,
      sources: files.api,
    });
    expect(short[0]!.excerpt).toEqual({ segments: [{ start: 1, lines: source.split('\n').slice(0, 5) }], omitted: 0 });
  });

  it('falls back from full to the term excerpt when the full definition does not fit the budget', async () => {
    const long = body(
      'long',
      Array.from({ length: 100 }, (_, i) => `  step${i}();`),
    );
    const found = await attachExcerpts({
      matches: [hit('a.ts', [1, 0, 102, 1])],
      query: 'step7',
      mode: 'full',
      budget: 600,
      sources: sources({ 'a.ts': long }).api,
    });
    expect(shown(found[0]!.excerpt!).length).toBeLessThanOrEqual(12);
  });

  it('never throws because of a file: a failing reader leaves pointers unchanged', async () => {
    const files = sources({ 'a.ts': source });
    files.api.read = () => Promise.reject(new Error('EACCES'));
    expect(await run([one], files, 'shift')).toEqual([one]);
  });
});
