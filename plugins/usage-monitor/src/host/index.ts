import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { PluginContext } from '@oxytocin/plugin-api';
import { DEFAULT_SETTINGS, type UsageSettings } from './settings';
import { WorkerClient } from './worker-rpc';

function readSettings(ctx: PluginContext): UsageSettings {
  const get = <T>(key: string, fallback: T): T => ctx.oxy.settings.get<T>(key) ?? fallback;
  return {
    costMode: get('usage.costMode', DEFAULT_SETTINGS.costMode),
    pricingAutoUpdate: get('usage.pricing.autoUpdate', DEFAULT_SETTINGS.pricingAutoUpdate),
    pricingOverrides: get('usage.pricing.overrides', DEFAULT_SETTINGS.pricingOverrides),
  };
}

/** Usage Monitor backend (docs/plan/08-usage-monitor.md §2): starts the ingest worker and forwards settings. */
export async function activate(ctx: PluginContext): Promise<void> {
  const worker = new Worker(new URL('./workers/ingest-worker.js', import.meta.url), {
    workerData: { dbPath: join(ctx.storage.globalDir, 'usage.db'), storageDir: ctx.storage.globalDir },
  });
  const client = new WorkerClient(worker);
  worker.on('error', (e: Error) => {
    ctx.log.error('The ingest worker failed', e);
    client.failAll(e);
  });
  client.onEvent((event, payload) => {
    if (event === 'log') ctx.log.warn((payload as { message: string }).message);
  });
  ctx.subscriptions.push({
    dispose: () => {
      void client.request('dispose').finally(() => void worker.terminate());
    },
  });
  const { schemaVersion } = await client.request<{ schemaVersion: number }>('init');
  ctx.log.info(`Usage database ready (schema ${schemaVersion})`);
  await client.request('setSettings', readSettings(ctx));
  ctx.subscriptions.push(
    ctx.oxy.settings.onDidChange('usage.', () => void client.request('setSettings', readSettings(ctx))),
  );
}
