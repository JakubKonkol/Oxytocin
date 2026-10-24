import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { ParserRuntime } from '../parse/runtime';
import { extractTypeScript } from '../extract/typescript';
import { buildSearchData } from '../extract/search-data';
import { normalizedSource } from '../extract/files';
import type { FileRecord } from '../extract/record';
import { buildGraph } from '../graph/build';
import { buildSearchCorpus } from './corpus';
import { CodeSearch } from './search';

let assets: string;
let parser: ParserRuntime;
beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'oxy-search-incremental-'));
  await copyCodeMapAssets(assets);
  parser = new ParserRuntime(assets);
});
afterAll(async () => {
  parser?.dispose();
  if (assets) await rm(assets, { recursive: true, force: true });
});

async function extract(path: string, source: string): Promise<FileRecord> {
  const text = normalizedSource(source);
  const tree = await parser.parse(text, 'typescript');
  try {
    const record = extractTypeScript(path, text, tree);
    record.search = buildSearchData(text, record.symbols);
    return record;
  } finally {
    tree.delete();
  }
}
const generator = {
  oxytocin: 'test',
  extractors: {},
  grammars: {},
  settingsHash: `sha256:${'0'.repeat(64)}`,
} as Parameters<typeof buildGraph>[2];

const files: Record<string, string> = {
  'src/terminal/flow-control.ts':
    'export class FlowControl { acknowledge(bytes: number) { return this.pending - bytes; } private pending = 0; }\nexport function createFlowControl() { return new FlowControl(); }\n',
  'src/terminal/mirror.ts':
    'export function serializeMirror(buffer: string[]) { return buffer.join("\\n"); }\nexport const mirrorLimit = 5000;\n',
  'src/git/refresh-scheduler.ts':
    'export function debounceRefresh(callback: () => void, delay: number) { let timer: number; return () => { clearTimeout(timer); timer = setTimeout(callback, delay); }; }\n',
  'src/git/status.ts':
    'export function readStatus() { return "clean"; }\nexport function parseStatusLine(line: string) { return line.trim(); }\n',
  'src/util/emitter.test.ts': 'import { describe } from "vitest";\ndescribe("emitter", () => {});\n',
  'src/util/emitter.ts': 'export class Emitter { fire() {} listen() {} }\n',
  'docs/notes.md': '# Notes\nThe terminal output uses flow control with acknowledgements.\n',
};
const queries = [
  'flow control acknowledgements',
  'debounce refresh',
  'serialize mirror buffer',
  'status line',
  'Emitter',
  'src/git/status.ts',
  'parseStatusLine',
  'emitter tests',
  'how is the terminal output acknowledged',
  'documentation notes',
  'zqprobe',
  'createFlowControl',
];

describe('incrementally updated search index', () => {
  it('answers every query like an index built from scratch after each kind of change', async () => {
    const records = new Map<string, FileRecord>();
    for (const [path, source] of Object.entries(files)) records.set(path, await extract(path, source));
    const snapshot = () => {
      const graph = buildGraph(records, new Map(), generator, 0);
      return { graph, corpus: buildSearchCorpus(records) };
    };
    const first = snapshot();
    const incremental = new CodeSearch(first.graph, first.corpus);
    const step = async (changed: string[], apply: () => Promise<void> | void) => {
      await apply();
      const next = snapshot();
      incremental.update(next.graph, next.corpus, new Set(changed));
      const fresh = new CodeSearch(next.graph, next.corpus);
      for (const query of queries) {
        expect(incremental.search(query, undefined, 8)).toEqual(fresh.search(query, undefined, 8));
        expect(incremental.search(query, 'src/git', 3)).toEqual(fresh.search(query, 'src/git', 3));
      }
    };
    await step(['src/git/status.ts'], async () => {
      records.set(
        'src/git/status.ts',
        await extract(
          'src/git/status.ts',
          `${files['src/git/status.ts']!}export function zqprobeHandler() { return 1; }\n`,
        ),
      );
    });
    await step(['src/terminal/flow-control.ts'], async () => {
      records.set(
        'src/terminal/flow-control.ts',
        await extract(
          'src/terminal/flow-control.ts',
          files['src/terminal/flow-control.ts']!.replace('acknowledge', 'ack'),
        ),
      );
    });
    await step(['src/util/extra.ts'], async () => {
      records.set(
        'src/util/extra.ts',
        await extract('src/util/extra.ts', 'export function extraHelper() { return "flow"; }\n'),
      );
    });
    await step(['src/terminal/mirror.ts'], () => {
      records.delete('src/terminal/mirror.ts');
    });
    await step(['src/terminal/mirror.ts', 'src/git/status.ts'], async () => {
      records.set('src/terminal/mirror.ts', await extract('src/terminal/mirror.ts', files['src/terminal/mirror.ts']!));
      records.set('src/git/status.ts', await extract('src/git/status.ts', files['src/git/status.ts']!));
    });
    // The same file edited repeatedly leaves dead documents behind; the answers stay equal.
    for (let round = 0; round < 6; round++)
      await step(['src/util/emitter.ts'], async () => {
        records.set(
          'src/util/emitter.ts',
          await extract(
            'src/util/emitter.ts',
            `${files['src/util/emitter.ts']!}export const round${round} = ${round};\n`,
          ),
        );
      });
  });

  it('builds in slices to the same index as the constructor', async () => {
    const records = new Map<string, FileRecord>();
    for (const [path, source] of Object.entries(files)) records.set(path, await extract(path, source));
    const graph = buildGraph(records, new Map(), generator, 0);
    const corpus = buildSearchCorpus(records);
    const built = (await CodeSearch.build(graph, corpus, () => false))!;
    const direct = new CodeSearch(graph, corpus);
    for (const query of queries) expect(built.search(query, undefined, 8)).toEqual(direct.search(query, undefined, 8));
  });

  it('asks for a rebuild once too many documents are dead', async () => {
    const records = new Map<string, FileRecord>();
    for (const [path, source] of Object.entries(files)) records.set(path, await extract(path, source));
    const graph = buildGraph(records, new Map(), generator, 0);
    const search = new CodeSearch(graph, buildSearchCorpus(records));
    let verdict = true;
    for (let round = 0; round < 40 && verdict; round++)
      verdict = search.update(graph, buildSearchCorpus(records), new Set(Object.keys(files)));
    expect(verdict).toBe(false);
  });
});
