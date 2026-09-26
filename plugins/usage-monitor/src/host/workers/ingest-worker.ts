/** Ingest worker (worker_threads inside the Plugin Host): owns the SQLite database and all heavy work. */
import { parentPort, workerData } from 'node:worker_threads';
import { type EngineOptions, UsageEngine } from '../engine';
import type { UsageSettings } from '../settings';
import { serveWorker } from '../worker-rpc';

const PRICING_CHECK_MS = 60 * 60 * 1000;

if (!parentPort) throw new Error('ingest-worker must run in a worker thread');
const options = workerData as Pick<EngineOptions, 'dbPath' | 'storageDir'>;
let engine: UsageEngine | undefined;
const emit = serveWorker(parentPort, {
  init: async () => ({ schemaVersion: (await ready).schemaVersion }),
  setSettings: async (settings: Partial<UsageSettings>) => {
    const e = await ready;
    e.setSettings(settings);
    void e.maybeRefreshPricing();
  },
  'pricing.list': async () => {
    const e = await ready;
    return {
      version: e.pricing.version,
      source: e.pricing.tableSource,
      fetchedAt: e.pricing.lastFetchedAt,
      models: e.pricing.list(),
    };
  },
  'pricing.refresh': async () => (await ready).maybeRefreshPricing(true),
  dispose: () => {
    engine?.close();
    engine = undefined;
  },
});

const ready = UsageEngine.create({
  ...options,
  warn: (message, error) =>
    emit('log', {
      level: 'warn',
      message: `${message}${error ? `: ${error instanceof Error ? error.message : JSON.stringify(error)}` : ''}`,
    }),
}).then((e) => {
  engine = e;
  setInterval(() => void e.maybeRefreshPricing(), PRICING_CHECK_MS).unref();
  return e;
});
