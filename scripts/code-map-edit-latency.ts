/**
 * Edit-loop latency of the Code Map host: an agent edits a file and immediately asks `oxy_find_code`. Indexes a
 * temporary copy of a checkout headlessly with the real `CodeMapCheckouts` controller, parser worker and grammars,
 * then N times appends a uniquely named exported function to a file and queries for that name with the default
 * `latest` freshness. Reports
 *   - the time until an answer contains the new name (p50/p95) and how often the first answer was stale,
 *   - the latency of a query when nothing changed (p50/p95),
 *   - the resident set size of this process after the run.
 * The checkout is never modified: the source tree is copied (tracked and unignored files) or generated.
 *
 *   npx tsx --tsconfig tsconfig.tools.json scripts/code-map-edit-latency.ts
 *     [--source repo|fixture] [--root <dir>] [--runs 12] [--idle-queries 60] [--edit-file <path>] [--output <file>]
 *
 * `--source repo` (default) copies this repository; `--source fixture` generates the 10,000-file TypeScript fixture
 * (`makeCodeMapFixture`); `--root` indexes a copy of any other directory.
 */
import { execFile } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import type { CodeMapStatus } from '../src/shared/domain/code-map';
import type { CodeMapHostQueryResult } from '../src/shared/domain/code-map-plugin';
import { CodeMapCheckouts } from '../src/code-map-host/checkouts';
import { copyCodeMapAssets } from './code-map-assets';
import { makeCodeMapFixture } from './make-fixtures';

const repo = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const source = option('source') ?? 'repo';
const runs = Number(option('runs') ?? 12);
const idleQueries = Number(option('idle-queries') ?? 60);
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const git = (cwd: string, ...gitArgs: string[]) => promisify(execFile)('git', ['--no-optional-locks', ...gitArgs], { cwd, maxBuffer: 64 << 20 });
const mib = (bytes: number) => Math.round(bytes / 1048576);

function percentile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const summary = (values: number[]) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50)),
  p95: Math.round(percentile(values, 95)),
  max: Math.round(Math.max(...values)),
});

async function prepare(directory: string): Promise<{ root: string; editFile: string }> {
  const root = join(directory, 'checkout');
  if (source === 'fixture') {
    await makeCodeMapFixture(root);
    await git(root, 'init', '-q');
    return { root, editFile: option('edit-file') ?? 'package-0/module-0.ts' };
  }
  const from = resolve(option('root') ?? repo);
  const listed = (await git(from, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).stdout
    .split('\0')
    .filter((path) => path && !path.startsWith('.oxy/') && !path.startsWith('.claude/'));
  for (let offset = 0; offset < listed.length; offset += 32)
    await Promise.all(
      listed.slice(offset, offset + 32).map(async (path) => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await cp(join(from, path), join(root, path)).catch(() => undefined);
      }),
    );
  await git(root, 'init', '-q');
  return { root, editFile: option('edit-file') ?? 'src/shared/utils/emitter.ts' };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'oxy-edit-latency-'));
  const work = join(directory, 'work');
  try {
    const { root, editFile } = await prepare(directory);
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
      'Oxytocin edit latency',
      (next) => {
        status = next;
      },
      { assets, parserEntry: join(work, 'parser.cjs') },
    );
    const settled = async (timeoutMs = 600_000) => {
      const deadline = performance.now() + timeoutMs;
      while (!status || !['ready', 'degraded'].includes(status.state) || status.pendingFiles) {
        if (status && ['error', 'limit'].includes(status.state)) throw new Error(status.error ?? status.state);
        if (performance.now() > deadline) throw new Error('Timed out waiting for the index');
        await delay(10);
      }
    };
    let counter = 0;
    const ask = async (query: string, freshness: 'latest' | 'verified' = 'latest') =>
      (await controller.query('latency', `q${++counter}`, {
        kind: 'search',
        query,
        limit: 5,
        freshness,
      })) as CodeMapHostQueryResult;
    const contains = (result: CodeMapHostQueryResult, name: string) =>
      result.data?.kind === 'search' && result.data.matches.some((match) => match.name === name);
    try {
      const start = performance.now();
      await controller.configure({
        checkoutId: 'latency',
        projectId: 'latency',
        root,
        mode: 'project',
        excludedPaths: [],
        ignoreInGit: false,
        gitPath: 'git',
      });
      if (status?.readOnly) throw new Error('Another Oxytocin instance owns this map');
      await settled();
      const indexMs = Math.round(performance.now() - start);
      await ask('warm up index'); // builds the search index of the first generation, as the first real query would
      await delay(1500);
      console.log(`Indexed ${status?.counts.files} files, ${status?.counts.symbols} symbols in ${indexMs} ms`);

      // 1. Queries when nothing changed.
      const phrases = ['emitter', 'terminal output flow control', 'package module create service', 'watcher debounce', 'Input5'];
      const idle: number[] = [];
      const idleVerified: number[] = [];
      for (let i = 0; i < idleQueries; i++) {
        const t = performance.now();
        await ask(phrases[i % phrases.length]!);
        idle.push(performance.now() - t);
      }
      for (let i = 0; i < Math.min(10, idleQueries); i++) {
        const t = performance.now();
        await ask(phrases[i % phrases.length]!, 'verified');
        idleVerified.push(performance.now() - t);
      }

      // 2. Edit, then query immediately.
      const firstAnswer: number[] = [];
      const untilFresh: number[] = [];
      const stalePolls: number[] = [];
      let staleFirst = 0;
      let missed = 0;
      for (let run = 0; run < runs; run++) {
        await settled();
        await delay(500);
        const name = `zqprobe${String.fromCharCode(97 + (run % 26))}${run}Handler`;
        const t0 = performance.now();
        await appendFile(
          join(root, editFile),
          `\nexport function ${name}(value: number): number {\n  return value + ${run};\n}\n`,
        );
        let result = await ask(name);
        firstAnswer.push(performance.now() - t0);
        const first = contains(result, name);
        if (!first) staleFirst++;
        let polls = 0;
        while (!contains(result, name) && performance.now() - t0 < 30_000) {
          polls++;
          await delay(25);
          result = await ask(name);
        }
        if (contains(result, name)) untilFresh.push(performance.now() - t0);
        else missed++;
        stalePolls.push(polls);
      }
      await settled();
      const rss = process.memoryUsage().rss;
      const report = {
        source,
        root: source === 'fixture' ? 'fixture-10000' : 'repo copy',
        files: status?.counts.files,
        symbols: status?.counts.symbols,
        indexMs,
        unchangedQueryMs: summary(idle),
        unchangedVerifiedQueryMs: summary(idleVerified),
        firstAnswerAfterEditMs: summary(firstAnswer),
        editToFreshAnswerMs: untilFresh.length ? summary(untilFresh) : null,
        firstAnswerStale: `${staleFirst}/${runs}`,
        neverFresh: missed,
        rssMiB: mib(rss),
      };
      console.log(JSON.stringify(report, null, 2));
      const output = option('output');
      if (output) {
        await mkdir(dirname(resolve(output)), { recursive: true });
        await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
      }
    } finally {
      await controller.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
