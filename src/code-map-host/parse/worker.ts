import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { ParserRuntime } from './runtime';
import { ParseJobSchema, ParseResultSchema } from '../extract/record';
import { normalizedSource } from '../extract/files';
import { extractTypeScript } from '../extract/typescript';
import { CodeMapLimitError } from '../enumerate';

const { assets } = z.object({ assets: z.string().min(1) }).parse(workerData);
const runtime = new ParserRuntime(assets);
if (!parentPort) throw new Error('Code Map parser requires a worker message port');
const port = parentPort;
port.on('message', (input: unknown) => {
  void (async () => {
    const job = ParseJobSchema.parse(input);
    try {
      const source = normalizedSource(job.source);
      const language = /\.tsx$/.test(job.path) ? 'tsx' : /\.[cm]?jsx?$/.test(job.path) ? 'javascript' : 'typescript';
      const tree = await runtime.parse(source, language);
      try {
        port.postMessage(ParseResultSchema.parse({ id: job.id, record: extractTypeScript(job.path, source, tree) }));
      } finally {
        tree.delete();
      }
    } catch (error) {
      port.postMessage({
        id: job.id,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        code: error instanceof CodeMapLimitError ? 'LIMIT' : 'PARSE',
      });
    }
  })().catch(() => process.exit(1));
});
