import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';
import { build } from 'esbuild';
import { copyCodeMapAssets } from './code-map-assets';
import { makeCodeMapFixture } from './make-fixtures';

async function run() {
  if (process.platform !== 'win32') throw new Error('Run the packaged Windows benchmark on Windows');
  const root = resolve(import.meta.dirname, '..');
  const output = resolve(process.argv[2] ?? join(root, 'test-results', 'code-map benchmark żółć'));
  const app = join(output, 'app'),
    packaged = join(output, 'packaged Windows żółć');
  await mkdir(app, { recursive: true });
  await build({
    entryPoints: {
      main: join(root, 'scripts/code-map-benchmark-main.ts'),
      worker: join(root, 'scripts/code-map-benchmark-worker.ts'),
      parser: join(root, 'src/code-map-host/parse/worker.ts'),
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outdir: app,
    outExtension: { '.js': '.cjs' },
    alias: {
      '@shared': join(root, 'src/shared'),
      'jsonc-parser': join(root, 'node_modules/jsonc-parser/lib/esm/main.js'),
      'web-tree-sitter': join(root, 'node_modules/web-tree-sitter/web-tree-sitter.cjs'),
    },
    external: ['electron', '@parcel/watcher'],
    logLevel: 'warning',
  });
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({ name: 'oxytocin-code-map-benchmark', version: '1.0.0', main: 'main.cjs', license: 'MIT' }),
  );
  await cp(join(root, 'node_modules/electron/dist'), packaged, { recursive: true });
  await rename(join(packaged, 'electron.exe'), join(packaged, 'Oxytocin Code Map Benchmark.exe'));
  await createPackage(app, join(packaged, 'resources/app.asar'));
  const assets = join(packaged, 'resources/code-map');
  await copyCodeMapAssets(assets);
  for (const name of [
    '@parcel/watcher',
    `@parcel/watcher-win32-${process.arch}`,
    'detect-libc',
    'is-glob',
    'is-extglob',
    'picomatch',
  ])
    await cp(join(root, 'node_modules', name), join(packaged, 'resources/node_modules', name), { recursive: true });
  const gitPath = (await promisify(execFile)('where.exe', ['git'], { windowsHide: true })).stdout
    .trim()
    .split(/\r?\n/)[0]!;
  const fixture = join(output, 'fixture 10000');
  await makeCodeMapFixture(fixture);
  const repo = join(output, 'Oxytocin snapshot');
  const tracked = (
    await promisify(execFile)(
      gitPath,
      ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, windowsHide: true, maxBuffer: 16 * 1048576 },
    )
  ).stdout
    .split('\0')
    .filter(Boolean)
    .filter((p) => !p.startsWith('.oxy/'));
  for (let offset = 0; offset < tracked.length; offset += 32)
    await Promise.all(
      tracked.slice(offset, offset + 32).map(async (path) => {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await cp(join(root, path), join(repo, path));
      }),
    );
  const jobs = [];
  for (const [name, directory, editFile] of [
    ['fixture-10000', fixture, 'package-0/module-0.ts'],
    ['oxytocin', repo, 'src/shared/utils/emitter.ts'],
  ] as const) {
    await promisify(execFile)(gitPath, ['--no-optional-locks', 'init'], { cwd: directory, windowsHide: true });
    const config = join(output, `${name}.json`);
    await writeFile(
      config,
      JSON.stringify({
        root: directory,
        assets,
        gitPath,
        editFile,
        idleMs: name === 'fixture-10000' ? 300_000 : 0,
        runs: 3,
      }),
    );
    jobs.push({ name, config });
  }
  const configPath = join(output, 'config.json'),
    resultPath = join(output, 'runs.json');
  await writeFile(configPath, JSON.stringify({ jobs, output: resultPath }));
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    const child = spawn(join(packaged, 'Oxytocin Code Map Benchmark.exe'), [`--benchmark=${configPath}`], {
      windowsHide: true,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Benchmark exited ${code}`))));
  });
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        machine: { cpu: cpus()[0]?.model, threads: cpus().length, memoryGiB: totalmem() / 1024 ** 3 },
        revision: (
          await promisify(execFile)(gitPath, ['--no-optional-locks', 'rev-parse', 'HEAD'], {
            cwd: root,
            windowsHide: true,
          })
        ).stdout.trim(),
        runs: JSON.parse(await readFile(resultPath, 'utf8')) as unknown,
      },
      null,
      2,
    ),
  );
  console.log(`Results: ${join(output, 'results.json')}`);
}
void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
