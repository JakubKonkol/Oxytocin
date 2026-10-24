/**
 * Retrieval accuracy and answer size of `oxy_find_code` on the frozen corpus. Indexes the checkout headlessly with
 * the real Code Map controller, parser worker and grammars, then asks every question through the host query path
 * and the MCP formatter. No agent or model is involved; numbers are characters, not billed tokens.
 *
 *   npx tsx --tsconfig tsconfig.tools.json scripts/code-map-retrieval-eval.ts [--root <dir>] [--output <file>] [--split train|heldout] [--excerpts none|terms] [--answers <file>]
 *
 * The checkout defaults to this repository (its `.oxy/` is git-ignored). Quit Oxytocin first if it maps the same
 * folder: another instance owning the map makes this run read-only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import type { CodeMapStatus } from '../src/shared/domain/code-map';
import type { CodeMapQueryResult } from '../src/shared/domain/code-map-query';
import { CodeMapCheckouts } from '../src/code-map-host/checkouts';
import { formatCodeMap } from '../src/main/services/mcp/code-map-format';
import { copyCodeMapAssets } from './code-map-assets';
import { distinctFiles, rankOf, RetrievalCorpusSchema, summarize, type RetrievalRow } from './lib/code-map-retrieval';

const repo = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const root = resolve(option('root') ?? repo);
const output = resolve(option('output') ?? join(repo, 'test-results', 'code-map-retrieval-eval.json'));
const split = option('split');
/** Agents get the matching source lines with every answer; `none` measures the pointer-only size. */
const excerpts = option('excerpts') === 'none' ? undefined : ('terms' as const);
const answersFile = option('answers');
const work = join(repo, 'test-results', 'code-map-retrieval-eval');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function main() {
  const corpus = RetrievalCorpusSchema.parse(
    JSON.parse(
      await readFile(option('corpus') ?? join(repo, 'scripts/fixtures/code-map-retrieval/corpus.json'), 'utf8'),
    ),
  );
  await build({
    entryPoints: { parser: join(repo, 'src/code-map-host/parse/worker.ts') },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outdir: work,
    outExtension: { '.js': '.cjs' },
    alias: {
      '@shared': join(repo, 'src/shared'),
      'jsonc-parser': join(repo, 'node_modules/jsonc-parser/lib/esm/main.js'),
      'web-tree-sitter': join(repo, 'node_modules/web-tree-sitter/web-tree-sitter.cjs'),
    },
    logLevel: 'warning',
  });
  const assets = join(work, 'assets');
  await copyCodeMapAssets(assets, repo);
  let status: CodeMapStatus | undefined;
  const controller = new CodeMapCheckouts(
    'Oxytocin retrieval eval',
    (next) => {
      status = next;
    },
    { assets, parserEntry: join(work, 'parser.cjs') },
  );
  try {
    const start = performance.now();
    await controller.configure({
      checkoutId: 'eval',
      projectId: 'eval',
      root,
      mode: 'project',
      excludedPaths: [],
      ignoreInGit: false,
      gitPath: 'git',
    });
    if (status?.readOnly) throw new Error('Another Oxytocin instance owns this map; quit it or pass --root');
    while (!status || !['ready', 'degraded'].includes(status.state) || status.pendingFiles) {
      if (status && ['error', 'limit'].includes(status.state)) throw new Error(status.error ?? status.state);
      await delay(20);
    }
    const indexMs = Math.round(performance.now() - start);
    const rows: RetrievalRow[] = [];
    const answers: string[] = [];
    for (const question of corpus.questions) {
      if (split && question.split !== split) continue;
      const result = (await controller.query('eval', question.id, {
        kind: 'search',
        query: question.question,
        limit: 8,
        freshness: 'allow-stale',
        ...(excerpts ? { excerpts } : {}),
      })) as CodeMapQueryResult;
      const answer = formatCodeMap(result);
      answers.push(`## ${question.id} ${question.question}\n${answer}\n`);
      const files = distinctFiles(result.data?.kind === 'search' ? result.data.matches.map((m) => m.path) : []);
      rows.push({
        id: question.id,
        split: question.split,
        question: question.question,
        rank: rankOf(files, question.expected),
        chars: answer.length,
        files,
      });
    }
    const report = {
      corpus: { version: corpus.version, revision: corpus.revision },
      root,
      indexMs,
      counts: status?.counts,
      all: summarize(rows),
      train: summarize(rows.filter((row) => row.split === 'train')),
      heldout: summarize(rows.filter((row) => row.split === 'heldout')),
      rows,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    if (answersFile) await writeFile(resolve(answersFile), answers.join('\n'));
    for (const row of rows)
      console.log(`${row.id} ${row.split.padEnd(7)} rank=${row.rank} chars=${row.chars} ${row.question}`);
    console.log(JSON.stringify({ indexMs, all: report.all, train: report.train, heldout: report.heldout }, null, 2));
    console.log(`Report: ${output}`);
  } finally {
    await controller.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
