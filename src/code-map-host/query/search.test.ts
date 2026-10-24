import { describe, expect, it } from 'vitest';
import { emptyCodeMapCoverage, type CodeMapGraph } from '@shared/domain/code-map';
import { fileRecord } from '../extract/files';
import type { FileRecord } from '../extract/record';
import { buildSearchData } from '../extract/search-data';
import { buildSearchCorpus } from './corpus';
import { CodeSearch } from './search';

/**
 * One source line per symbol: `function name() { body }`; lines starting with `//` have no symbol and become the
 * file residual. Builds the graph and corpus the engine would publish for these files.
 */
function project(files: Record<string, string[]>, withCorpus = true) {
  const records = new Map<string, FileRecord>();
  for (const [path, lines] of Object.entries(files)) {
    const source = lines.join('\n');
    const record = fileRecord(path, source);
    lines.forEach((line, i) => {
      const name = /^(?:function|class|const) (\w+)/.exec(line)?.[1];
      if (name)
        record.symbols.push({
          id: `s:${path}#${name}`,
          file: record.file.id,
          kind: 'function',
          name,
          owner: null,
          exported: true,
          signature: line.slice(0, line.indexOf('{') < 0 ? undefined : line.indexOf('{')).trim(),
          span: [i + 1, 0, i + 1, line.length],
        });
    });
    record.search = buildSearchData(source, record.symbols);
    records.set(path, record);
  }
  const graph: CodeMapGraph = {
    format: 'oxytocin.code-map',
    schemaVersion: 1,
    generator: { oxytocin: 'test', extractors: {}, grammars: {}, settingsHash: `sha256:${'0'.repeat(64)}` },
    files: [...records.values()].map((record) => record.file),
    groups: [],
    packages: [],
    coverage: emptyCodeMapCoverage(),
    unresolved: [],
    symbols: [...records.values()].flatMap((record) => record.symbols),
    edges: [],
  };
  return { graph, search: new CodeSearch(graph, withCorpus ? buildSearchCorpus(records) : undefined) };
}
const paths = (found: { matches: { path: string }[] }) => found.matches.map((match) => match.path);

/** Filler files so that inverse document frequencies are not degenerate. */
const filler = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`src/filler/f${i}.ts`, [`function unrelated${i}() { return ${i}; }`]]),
);

describe('Code Map body-aware ranking', () => {
  it('finds a file whose decisive words occur only inside a function body', () => {
    const files = {
      ...filler,
      'src/preload/index.ts': [
        "import { webUtils } from 'electron';",
        'const api = { getPathForFile: (file) => webUtils.getPathForFile(file) };',
      ],
      'src/terminals/path-quoting.ts': ['function formatDroppedPaths(paths) { return paths.map(quote); }'],
    };
    const question = 'where is webUtils used to turn a dropped file into a path';
    expect(paths(project(files).search.search(question, undefined, 5))[0]).toBe('src/preload/index.ts');
    // Without body postings only names, paths and signatures are indexed, as before.
    expect(paths(project(files, false).search.search('webUtils electron', undefined, 5))).toEqual([]);
  });

  it('puts the best symbol of each file first and lists further symbols after the distinct files', () => {
    const { search } = project({
      ...filler,
      'src/a.ts': [
        'function alphaParse() { parse tokens }',
        'function alphaEmit() { emit tokens }',
        'function alphaWalk() { walk tokens }',
      ],
      'src/b.ts': ['function betaParse() { parse tokens quickly }'],
      'src/c.ts': ['function gammaTokens() { tokens }'],
    });
    const found = search.search('parse tokens', undefined, 6).matches;
    expect(new Set(found.slice(0, 3).map((match) => match.path)).size).toBe(3);
    expect(found.map((match) => match.name).slice(0, 3)).toContain('alphaParse');
    // Distinct files first, then more symbols of those files, never more than `limit` rows in total.
    expect(found.length).toBeLessThanOrEqual(6);
    const firstRepeat = found.findIndex((match, i) => found.slice(0, i).some((other) => other.path === match.path));
    if (firstRepeat >= 0) expect(found.slice(0, firstRepeat).map((m) => m.path)).toHaveLength(firstRepeat);
    expect(search.search('parse tokens', undefined, 2).matches).toHaveLength(2);
  });

  it('scores a file by its best symbol plus a bonus for further matching symbols', () => {
    const { search } = project({
      ...filler,
      'src/many.ts': [
        'function render() { cache entries plus several filler words }',
        'function renderTwo() { cache entries plus several filler words }',
        'function renderThree() { cache entries plus several filler words }',
      ],
      'src/single.ts': ['function single() { cache entries plus several filler }'],
    });
    // The single symbol is the better match on its own, yet the file with three matching symbols wins.
    const rows = search.search('cache entries', undefined, 10).matches;
    const single = rows.find((row) => row.name === 'single')!;
    const further = rows.find((row) => row.name === 'renderTwo')!;
    const many = rows.find((row) => row.path === 'src/many.ts')!;
    expect(single.score).toBeGreaterThan(further.score);
    expect(many.score).toBeGreaterThan(single.score);
    expect(paths(search.search('cache entries', undefined, 3))[0]).toBe('src/many.ts');
  });

  it('multiplies by the squared idf-weighted share of the question matched', () => {
    const { search } = project({
      ...filler,
      'src/d.ts': ['function d() { alpha beta }'],
      'src/e.ts': ['function e() { gamma delta }'],
      'src/full.ts': ['function full() { alpha beta gamma delta }'],
    });
    const both = search.search('alpha beta', undefined, 5).matches.find((match) => match.path === 'src/d.ts')!;
    const quarter = search.search('alpha beta gamma delta', undefined, 5).matches.find((m) => m.path === 'src/d.ts')!;
    // Two of four equally rare terms: half of the weight, so a quarter of the score.
    expect(quarter.score / both.score).toBeCloseTo(0.25, 2);
    const found = search.search('alpha beta gamma delta', undefined, 5);
    expect(paths(found)[0]).toBe('src/full.ts');
    expect(found.coverage).toBe(1);
  });

  it('ranks test files lower unless the question asks for tests', () => {
    const { search } = project({
      ...filler,
      'src/session.ts': ['function connect() { open the session handle }'],
      'tests/session.test.ts': ['function connect() { open session handle open session handle open session handle }'],
    });
    expect(paths(search.search('open session handle', undefined, 2))).toEqual([
      'src/session.ts',
      'tests/session.test.ts',
    ]);
    const lower = search.search('open session handle', undefined, 2).matches[1]!;
    expect(lower.whyIncluded).toContain('test file ranked lower');
    expect(paths(search.search('tests for open session handle', undefined, 2))[0]).toBe('tests/session.test.ts');
    expect(paths(search.search('spec of open session handle', undefined, 2))[0]).toBe('tests/session.test.ts');
    const mentioned = search
      .search('open session handle in the e2e fixtures', undefined, 2)
      .matches.find((match) => match.path.startsWith('tests/'))!;
    expect(mentioned.whyIncluded).not.toContain('test file ranked lower');
  });

  it('ranks Markdown, JSON and text lower unless the question is about documentation', () => {
    const { search } = project({
      ...filler,
      'src/limits.ts': ['function limits() { rate limit window }'],
      'docs/limits.md': ['// rate limit window rate limit window rate limit window'],
      'data/limits.json': ['// rate limit window rate limit window rate limit window'],
    });
    expect(paths(search.search('rate limit window', undefined, 3))[0]).toBe('src/limits.ts');
    const low = search.search('rate limit window', undefined, 3).matches.filter((match) => !match.path.endsWith('.ts'));
    expect(low.every((match) => match.whyIncluded.includes('text file ranked lower'))).toBe(true);
    const asked = search.search('docs: rate limit window readme', undefined, 3).matches;
    expect(asked.some((match) => match.whyIncluded.includes('text file ranked lower'))).toBe(false);
  });

  it('lets an exact identifier or path in the question win over lexical scores', () => {
    const { search } = project({
      ...filler,
      'src/settings.ts': ['function getSettings() { return stored }'],
      'src/cache.ts': ['function refresh() { settings cache expires expiry timeout ' + 'get '.repeat(5) + ' }'],
      'src/other.ts': ['function other() { return 2 }'],
    });
    const sentence = 'why does the settings cache expire when getSettings is called, expiry timeout';
    expect(paths(search.search(sentence, undefined, 3))[0]).toBe('src/settings.ts');
    expect(search.search(sentence, undefined, 3).matches[0]!.whyIncluded).toContain('exact name');
    expect(search.search('getSettings', undefined, 5).matches.map((match) => match.id)).toEqual([
      's:src/settings.ts#getSettings',
    ]);
    expect(search.search('where is src/other.ts', undefined, 3).matches[0]!.id).toBe('f:src/other.ts');
    expect(search.search('src/other.ts', undefined, 5).matches.map((match) => match.path)).toEqual([
      'src/other.ts',
      'src/other.ts',
    ]);
    // Plain and ALL-CAPS words in a question are vocabulary, not identifiers.
    const plain = project({
      ...filler,
      'src/head.ts': ['const head = 1'],
      'src/read.ts': ['function readHead() { read the HEAD ref }'],
    });
    expect(paths(plain.search.search('how do we read the HEAD ref', undefined, 2))[0]).toBe('src/read.ts');
  });

  it('reports how well the best result matches the question', () => {
    const { search } = project({
      ...filler,
      'src/flow-control.ts': ['function createFlowControl() { ack window }'],
      'src/channel.ts': ['function pump() { await acknowledgement window }'],
    });
    const named = search.search('flow control', undefined, 3);
    expect(named.strong).toBe(true);
    expect(named.coverage).toBe(1);
    const bodyOnly = search.search('acknowledgement window', undefined, 3);
    expect(bodyOnly.matches[0]!.path).toBe('src/channel.ts');
    expect(bodyOnly.strong).toBe(false);
    expect(bodyOnly.coverage).toBeGreaterThan(0.5);
    const none = search.search('zzzz qqqq', undefined, 3);
    expect(none).toEqual({ matches: [], truncated: false });
    const partial = search.search('flow control zebra', undefined, 3);
    expect(partial.coverage).toBeLessThanOrEqual(1);
  });

  it('is deterministic and restricts results to a path prefix', () => {
    const files = {
      ...filler,
      'src/a/one.ts': ['function one() { shared term }'],
      'src/b/two.ts': ['function two() { shared term }'],
    };
    const first = project(files).search,
      second = project(files).search;
    expect(first.search('shared term', undefined, 5)).toEqual(second.search('shared term', undefined, 5));
    expect(paths(first.search('shared term', 'src/a', 5))).toEqual(['src/a/one.ts']);
  });
});
