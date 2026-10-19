import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { copyCodeMapAssets } from '../../../scripts/code-map-assets';
import { fileRecord } from '../extract/files';
import { ParserClient } from './client';

let directory: string;
const clients: ParserClient[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oxy-worker-test-'));
  await copyCodeMapAssets(join(directory, 'assets'));
  await build({
    entryPoints: [resolve('src/code-map-host/parse/worker.ts')],
    outfile: join(directory, 'worker.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: {
      '@shared': resolve('src/shared'),
      'web-tree-sitter': resolve('node_modules/web-tree-sitter/web-tree-sitter.cjs'),
    },
    logLevel: 'silent',
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
function client(entry = join(directory, 'worker.cjs'), timeout = 2500) {
  const result = new ParserClient(entry, join(directory, 'assets'), timeout);
  clients.push(result);
  return result;
}

describe('Code Map parser isolation', () => {
  it('reuses a parser thread, validates messages and supports cancellation', async () => {
    const parser = client();
    const results = await Promise.all([
      parser.parse('first.ts', 'export function first() {}'),
      parser.parse('second.tsx', 'export const Second = () => <div />;'),
    ]);
    expect(results[0].symbols[0]!.name).toBe('first');
    expect(results[1].symbols[0]!.kind).toBe('component');
    await expect(parser.parse('../outside.ts', '')).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(parser.parse('cancelled.ts', '', abort.signal)).rejects.toThrow();
  });
  it('terminates a blocked parser thread and starts a fresh one for the next file', async () => {
    const entry = join(directory, 'blocked.cjs');
    await writeFile(
      entry,
      `const {parentPort}=require('node:worker_threads'); let started=false; parentPort.on('message', job => { if (started) return; started=true; parentPort.postMessage({id:job.id,record:${JSON.stringify(fileRecord('a.ts', ''))}}); setImmediate(()=>{while(true){}}); });`,
    );
    const parser = client(entry, 1500);
    await expect(parser.parse('a.ts', '')).resolves.toMatchObject({ file: { path: 'a.ts' } });
    await expect(parser.parse('b.ts', '')).rejects.toThrow('deadline exceeded');
    await expect(parser.parse('a.ts', '')).resolves.toMatchObject({ file: { path: 'a.ts' } });
  });
  it('rejects malformed extraction records from a worker', async () => {
    const entry = join(directory, 'malformed.cjs');
    await writeFile(
      entry,
      "const {parentPort}=require('node:worker_threads'); parentPort.on('message', job => parentPort.postMessage({id:job.id,record:{}}));",
    );
    await expect(client(entry).parse('a.ts', '')).rejects.toThrow();
  });
});
