import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlugin } from '../../scripts/lib/plugin-build';
import { WorkerClient } from '../../plugins/usage-monitor/src/host/worker-rpc';

const plugin = resolve(__dirname, '../../plugins/usage-monitor');
let storageDir: string;
let worker: Worker;
let client: WorkerClient;

beforeAll(async () => {
  await buildPlugin(plugin);
  storageDir = await mkdtemp(join(tmpdir(), 'oxy-usage-worker-'));
  worker = new Worker(join(plugin, 'dist/workers/ingest-worker.js'), {
    workerData: { dbPath: join(storageDir, 'usage.db'), storageDir },
  });
  client = new WorkerClient(worker);
}, 60_000);

afterAll(async () => {
  await client.request('dispose').catch(() => undefined);
  await worker.terminate();
  await rm(storageDir, { recursive: true, force: true });
});

describe('bundled ingest worker', () => {
  it('opens the SQLite database in a worker thread and serves pricing', async () => {
    expect(await client.request('init')).toEqual({ schemaVersion: 1 });
    await client.request('setSettings', { pricingAutoUpdate: false });
    const pricing = await client.request<{ source: string; models: { model: string }[] }>('pricing.list');
    expect(pricing.source).toBe('snapshot');
    expect(pricing.models.map((m) => m.model)).toContain('claude-opus-5-5');
    await expect(client.request('nope')).rejects.toThrow(/Unknown method/);
  });
});
