import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createPackage } from '@electron/asar';
import { build } from 'esbuild';
import { copyCodeMapAssets } from './code-map-assets';
import { makeCodeMapFixture } from './make-fixtures';

const root = resolve(import.meta.dirname, '..');
const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? join(root, 'test-results', 'code-map spike żółć'),
);

async function execute(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    const child = spawn(file, args, { cwd, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', (data: Buffer) => {
      errors.push(data);
      process.stderr.write(data);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timeout: ${file}`));
    }, 600_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Exit ${code}: ${Buffer.concat(errors).toString()}`));
      else resolve(Buffer.concat(chunks).toString());
    });
  });
}

async function treeSize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    bytes += entry.isDirectory() ? await treeSize(file) : (await stat(file)).size;
  }
  return bytes;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32')
    throw new Error('This spike records Windows packaging measurements; run on Windows');
  const appDirectory = join(output, 'app');
  await mkdir(appDirectory, { recursive: true });
  await build({
    entryPoints: {
      main: join(root, 'scripts/code-map-spike-main.ts'),
      worker: join(root, 'scripts/code-map-spike-worker.ts'),
    },
    outdir: appDirectory,
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    format: 'cjs',
    bundle: true,
    alias: { 'web-tree-sitter': join(root, 'node_modules/web-tree-sitter/web-tree-sitter.cjs') },
    external: ['electron'],
    logLevel: 'warning',
  });
  await writeFile(
    join(appDirectory, 'package.json'),
    JSON.stringify({ name: 'oxytocin-code-map-spike', version: '1.0.0', main: 'main.cjs', license: 'MIT' }),
  );
  const assets = join(output, 'dev-resources', 'code-map');
  await copyCodeMapAssets(assets);
  const fixture = join(output, 'fixture 10000');
  if (!process.argv.includes('--reuse-fixture')) await makeCodeMapFixture(fixture);
  const fixtureFiles = Array.from({ length: 10_000 }, (_, index) =>
    join(fixture, `package-${Math.floor(index / 100)}`, `module-${index}.ts`),
  );
  const tracked = await execute(
    'git',
    ['--no-optional-locks', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    root,
  );
  const repoFiles = [...new Set(tracked.split('\0').filter((file) => /\.[cm]?[jt]sx?$/.test(file)))]
    .sort()
    .map((file) => join(root, file));
  const electronDirectory = join(root, 'node_modules/electron/dist');
  const packaged = join(output, 'packaged Windows żółć');
  await cp(electronDirectory, packaged, { recursive: true });
  await rename(join(packaged, 'electron.exe'), join(packaged, 'Oxytocin Parser Spike.exe'));
  await createPackage(appDirectory, join(packaged, 'resources', 'app.asar'));
  const packagedAssets = join(packaged, 'resources', 'code-map');
  await copyCodeMapAssets(packagedAssets);
  const runs: unknown[] = [];
  for (const mode of ['dev', 'packaged'] as const) {
    const jobs: { name: string; config: string }[] = [];
    for (const [name, files] of [
      ['oxytocin', repoFiles],
      ['fixture-10000', fixtureFiles],
    ] as const) {
      for (const backend of ['tree-sitter', 'typescript']) {
        const file = join(output, `${mode}-${name}-${backend}.json`);
        await writeFile(
          file,
          JSON.stringify({ assets: mode === 'dev' ? assets : packagedAssets, backend, files, csharpFiles: 0 }),
        );
        jobs.push({ name: `${name}-${backend}`, config: file });
      }
    }
    const csharp = join(output, `${mode}-csharp.json`);
    await writeFile(
      csharp,
      JSON.stringify({
        assets: mode === 'dev' ? assets : packagedAssets,
        backend: 'tree-sitter',
        files: [],
        csharpFiles: 10_000,
      }),
    );
    jobs.push({ name: 'csharp-10000', config: csharp });
    const config = join(output, `${mode}-config.json`);
    const result = join(output, `${mode}-results.json`);
    await writeFile(config, JSON.stringify({ jobs, output: result }));
    console.log(`Measuring ${mode}: ${repoFiles.length} repository files and 10,000-file fixtures`);
    await execute(
      mode === 'dev' ? join(electronDirectory, 'electron.exe') : join(packaged, 'Oxytocin Parser Spike.exe'),
      [...(mode === 'dev' ? [appDirectory] : []), `--spike-config=${config}`],
      output,
    );
    runs.push(JSON.parse(await readFile(result, 'utf8')) as unknown);
  }
  const report = {
    recordedAt: new Date().toISOString(),
    revision: (await execute('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], root)).trim(),
    machine: {
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model,
      threads: cpus().length,
      memoryGiB: totalmem() / 1024 ** 3,
    },
    hostNode: process.version,
    assetBytes: await treeSize(assets),
    packagedBytes: await treeSize(packaged),
    runs,
  };
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`Results: ${join(output, 'results.json')}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
