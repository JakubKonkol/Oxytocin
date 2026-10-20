import { readFile, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { CodeMapStatus } from '../src/shared/domain/code-map';
import { CodeMapCheckouts } from '../src/code-map-host/checkouts';

const Config = z.object({
  root: z.string(),
  assets: z.string(),
  gitPath: z.string(),
  editFile: z.string(),
  idleMs: z.number().nonnegative(),
  runs: z.number().int().positive(),
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function run() {
  Socket.prototype.connect = () => {
    throw new Error('Network disabled in benchmark');
  };
  globalThis.fetch = () => Promise.reject(new Error('Network disabled in benchmark'));
  const config = Config.parse(JSON.parse(await readFile(process.argv[2]!, 'utf8')));
  let status: CodeMapStatus | undefined;
  const controller = new CodeMapCheckouts(
    'Oxytocin benchmark',
    (next) => {
      status = next;
    },
    { assets: config.assets, parserEntry: join(__dirname, 'parser.cjs') },
  );
  const wait = async (generation: number) => {
    const end = performance.now() + 600_000;
    while (!status || !['ready', 'degraded'].includes(status.state) || status.generation <= generation) {
      if (status?.state === 'error' || status?.state === 'limit') throw new Error(status.error ?? status.state);
      if (performance.now() > end) throw new Error('Benchmark index timeout');
      await delay(10);
    }
  };
  const cold = [],
    edits = [],
    phases = [];
  for (let run = 0; run < config.runs; run++) {
    await controller.deleteData('benchmark', config.root);
    status = undefined;
    const start = performance.now();
    await controller.configure({
      checkoutId: 'benchmark',
      projectId: 'benchmark',
      root: config.root,
      mode: 'project',
      excludedPaths: [],
      ignoreInGit: false,
      gitPath: config.gitPath,
    });
    await wait(0);
    cold.push(performance.now() - start);
    phases.push(JSON.parse(await readFile(join(config.root, '.oxy/code-map/manifest.json'), 'utf8')) as unknown);
  }
  const sourcePath = join(config.root, config.editFile),
    source = await readFile(sourcePath, 'utf8');
  for (let edit = 0; edit < 10; edit++) {
    const generation = status!.generation,
      start = performance.now();
    await writeFile(
      sourcePath,
      config.editFile.endsWith('.cs')
        ? `${source}\npublic static class BenchmarkEdit${edit} { public static int Value() => ${edit}; }\n`
        : `${source}\nexport function benchmarkEdit${edit}() { return ${edit}; }\n`,
    );
    await wait(generation);
    edits.push(performance.now() - start);
  }
  await writeFile(sourcePath, source);
  await wait(status!.generation);
  const idleStart = process.cpuUsage(),
    started = performance.now();
  const idleGeneration = status!.generation;
  await delay(config.idleMs);
  const idle = process.cpuUsage(idleStart);
  const result = {
    coldMs: cold,
    editMs: edits,
    phases,
    idleMs: performance.now() - started,
    idleCpuPercentOfCore: ((idle.user + idle.system) / ((performance.now() - started) * 1000)) * 100,
    idleGenerationChanged: status!.generation !== idleGeneration,
    status,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    retainedRssMiB: process.memoryUsage().rss / 1048576,
    versions: process.versions,
  };
  await controller.dispose();
  process.parentPort.postMessage(result);
}
void run().catch((error: unknown) => {
  process.parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
