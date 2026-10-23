import { describe, expect, it } from 'vitest';
import { FileSearchSchema } from './record';
import { buildSearchData } from './search-data';
import { decodeDoc } from '../query/corpus';
import { BODY_LIMITS, stem } from '../query/terms';

function termsOf(search: ReturnType<typeof buildSearchData>, doc: { n: number; t: string }): Map<string, number> {
  const decoded = decodeDoc(doc, search.terms.length);
  return new Map(decoded.index.map((index, i) => [search.terms[index]!, decoded.count[i]!]));
}

describe('File search data', () => {
  const source = [
    "import { webUtils } from 'electron';", // 1
    '// Header about drag and drop', // 2
    'export class Bridge {', // 3
    '  /** Absolute path of a dropped File. */', // 4
    '  getPathForFile(file) { return webUtils.getPathForFile(file); }', // 5
    '  other() { return 1; }', // 6
    '}', // 7
    'export const LIMIT = 5;', // 8
  ].join('\n');
  const symbols = [
    { span: [3, 7, 7, 1] as [number, number, number, number] }, // class Bridge (from `class`)
    { span: [5, 2, 5, 200] as [number, number, number, number] }, // method getPathForFile
    { span: [6, 2, 6, 23] as [number, number, number, number] }, // method other
    { span: [8, 13, 8, 23] as [number, number, number, number] }, // variable LIMIT
  ];

  it('splits the source into symbol-own text and a residual outside top-level symbols', () => {
    const data = buildSearchData(source, symbols);
    expect(FileSearchSchema.safeParse(data).success).toBe(true);
    expect(data.symbols).toHaveLength(symbols.length);
    const residual = termsOf(data, data.residual);
    // Imports, header comments and the `export` prefix lines outside symbols.
    expect(residual.has(stem('util'))).toBe(true);
    expect(residual.has(stem('electron'))).toBe(true);
    expect(residual.has(stem('header'))).toBe(true);
    expect(residual.has(stem('drag'))).toBe(true);
    expect(residual.has(stem('bridge'))).toBe(false);
    expect(residual.has(stem('limit'))).toBe(false);
    const klass = termsOf(data, data.symbols[0]!);
    // The class keeps its own text (doc comment) but not the bodies of its member symbols.
    expect(klass.has(stem('absolute'))).toBe(true);
    expect(klass.has(stem('bridge'))).toBe(true);
    expect(klass.has(stem('web'))).toBe(false);
    expect(termsOf(data, data.symbols[1]!).get('path')).toBe(2);
    expect(termsOf(data, data.symbols[2]!).has(stem('other'))).toBe(true);
    expect(termsOf(data, data.symbols[3]!).has(stem('limit'))).toBe(true);
    expect(data.symbols[1]!.n).toBeGreaterThan(0);
  });

  it('indexes a bounded prefix of a file without symbols', () => {
    const lines = Array.from({ length: BODY_LIMITS.lines + 100 }, (_, i) =>
      i < BODY_LIMITS.lines ? `alpha${i % 7}` : 'omega',
    );
    const data = buildSearchData(lines.join('\n'), []);
    expect(data.symbols).toEqual([]);
    const residual = termsOf(data, data.residual);
    expect(residual.has('alpha1')).toBe(true);
    expect(residual.has(stem('omega'))).toBe(false);
    expect(data.residual.n).toBe(BODY_LIMITS.lines);
  });

  it('bounds symbol text by characters and distinct terms by the per-document limit', () => {
    const long = `function f() { ${'wordy '.repeat(100_000)} tailterm }`;
    const data = buildSearchData(long, [{ span: [1, 0, 1, long.length] }]);
    expect(data.symbols[0]!.n).toBeLessThanOrEqual(BODY_LIMITS.chars);
    expect(termsOf(data, data.symbols[0]!).has(stem('tailterm'))).toBe(false);
    const distinct = Array.from({ length: BODY_LIMITS.terms + 300 }, (_, i) => `unique${i.toString(36)}x`).join(' ');
    const wide = buildSearchData(distinct, []);
    expect(wide.terms.length).toBeLessThanOrEqual(BODY_LIMITS.terms);
    expect(FileSearchSchema.safeParse(wide).success).toBe(true);
  });

  it('is deterministic and tolerates spans beyond the end of the source', () => {
    expect(buildSearchData(source, symbols)).toEqual(buildSearchData(source, symbols));
    const data = buildSearchData('const alpha = 1;', [{ span: [5, 0, 9, 3] }, { span: [1, 0, 1, 99] }]);
    expect(data.symbols).toHaveLength(2);
    expect(termsOf(data, data.symbols[0]!).size).toBe(0);
    expect(termsOf(data, data.symbols[1]!).has('alpha')).toBe(true);
  });

  it('gives identical symbol spans each the shared text instead of dropping it', () => {
    const data = buildSearchData('export default function alpha() {}', [
      { span: [1, 15, 1, 34] },
      { span: [1, 15, 1, 34] },
    ]);
    expect(termsOf(data, data.symbols[0]!).has('alpha')).toBe(true);
    expect(termsOf(data, data.symbols[1]!).has('alpha')).toBe(true);
  });

  it('decodes counts, skips unknown term indexes and survives malformed text', () => {
    expect(decodeDoc({ n: 9, t: '0 3*4 12 7*0' }, 8)).toEqual({ n: 9, index: [0, 3, 7], count: [1, 4, 1] });
    expect(decodeDoc({ n: 0, t: '' }, 8)).toEqual({ n: 0, index: [], count: [] });
    expect(() => decodeDoc({ n: 1, t: '**  abc 2*' }, 8)).not.toThrow();
  });
});
