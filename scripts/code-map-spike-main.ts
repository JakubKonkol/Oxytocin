import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, utilityProcess } from 'electron';
import { z } from 'zod';

const ConfigSchema = z.object({
  jobs: z.array(z.object({ name: z.string(), config: z.string() })),
  output: z.string(),
});

// A measurement harness: no windows, application UI, renderer or project code.
void app
  .whenReady()
  .then(async () => {
    const argument = process.argv.find((value) => value.startsWith('--spike-config='));
    if (!argument) throw new Error('Missing spike configuration');
    const config = ConfigSchema.parse(JSON.parse(await readFile(argument.slice('--spike-config='.length), 'utf8')));
    if (argument.includes('packaged-config.json') && !app.isPackaged)
      throw new Error('Expected a packaged application');
    const results: unknown[] = [];
    for (const job of config.jobs) {
      const start = performance.now();
      results.push(
        await new Promise<unknown>((resolve, reject) => {
          const child = utilityProcess.fork(join(__dirname, 'worker.cjs'), [job.config], {
            serviceName: 'Oxytocin Code Map Parser Spike',
            stdio: 'pipe',
            env: { ...process.env, PATH: '', Path: '' },
          });
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Parser timeout: ${job.name}`));
          }, 180_000);
          child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
          child.once('message', (result: unknown) => {
            clearTimeout(timer);
            child.kill();
            if (typeof result === 'object' && result !== null && 'error' in result) {
              reject(new Error(`${job.name}: ${String(result.error)}`));
              return;
            }
            resolve({ name: job.name, forkToResultMs: performance.now() - start, result });
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Utility process exited before a result: ${code}`));
          });
        }),
      );
    }
    await writeFile(config.output, JSON.stringify({ packaged: app.isPackaged, results }, null, 2));
    app.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    app.exit(1);
  });
