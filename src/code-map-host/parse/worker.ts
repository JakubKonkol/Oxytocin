import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { ParserRuntime } from './runtime';
import { ParseJobSchema, ParseResultSchema } from '../extract/record';
import { normalizedSource } from '../extract/files';
import { extractTypeScript } from '../extract/typescript';
import { extractCSharp } from '../extract/csharp';
import { extractGo } from '../extract/go';
import { extractJava } from '../extract/java';
import { extractPython } from '../extract/python';
import { parserLanguage } from '../extract/languages';
import { buildSearchData } from '../extract/search-data';
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
      const language = parserLanguage(job.path);
      if (!language) throw new Error('Code Map has no parser for this file');
      const tree = await runtime.parse(source, language);
      try {
        const record =
          language === 'python'
            ? extractPython(job.path, source, tree)
            : language === 'java'
              ? extractJava(job.path, source, tree)
              : language === 'go'
                ? extractGo(job.path, source, tree)
                : language === 'csharp'
                  ? extractCSharp(job.path, source, tree)
                  : extractTypeScript(job.path, source, tree);
        record.search = buildSearchData(source, record.symbols);
        port.postMessage(ParseResultSchema.parse({ id: job.id, record }));
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
