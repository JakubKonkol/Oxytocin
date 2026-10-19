import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, utilityProcess } from 'electron';
import { z } from 'zod';

// The packaged smoke and benchmark have no BrowserWindow or renderer.
void app
  .whenReady()
  .then(async () => {
    if (!app.isPackaged) throw new Error('Expected a packaged benchmark');
    const path = process.argv.find((arg) => arg.startsWith('--benchmark='))?.slice('--benchmark='.length);
    if (!path) throw new Error('Missing configuration');
    const config = z
      .object({ jobs: z.array(z.object({ name: z.string(), config: z.string() })), output: z.string() })
      .parse(JSON.parse(await readFile(path, 'utf8')));
    const results = [];
    for (const job of config.jobs) {
      const result = await new Promise<unknown>((resolve, reject) => {
        const child = utilityProcess.fork(join(__dirname, 'worker.cjs'), [job.config], {
          serviceName: 'Oxytocin Code Map Benchmark',
          stdio: 'pipe',
          env: { ...process.env, PATH: '', Path: '' },
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Benchmark timeout'));
        }, 1_800_000);
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
        child.once('message', (result: unknown) => {
          clearTimeout(timer);
          child.kill();
          resolve(result);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Benchmark exit ${code}`));
        });
      });
      results.push({ name: job.name, result });
      await writeFile(config.output, JSON.stringify({ packaged: true, results }, null, 2));
    }
    app.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    app.exit(1);
  });
