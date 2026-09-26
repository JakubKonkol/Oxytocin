import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { AgentSnapshot, PluginContext } from '@oxytocin/plugin-api';
import { type CollectorSettings, DEFAULT_SETTINGS, type UsageSettings } from './settings';
import { WorkerClient } from './worker-rpc';

function settingsReader(ctx: PluginContext) {
  return <T>(key: string, fallback: T): T => ctx.oxy.settings.get<T>(key) ?? fallback;
}

function readSettings(ctx: PluginContext): UsageSettings {
  const get = settingsReader(ctx);
  return {
    costMode: get('usage.costMode', DEFAULT_SETTINGS.costMode),
    pricingAutoUpdate: get('usage.pricing.autoUpdate', DEFAULT_SETTINGS.pricingAutoUpdate),
    pricingOverrides: get('usage.pricing.overrides', DEFAULT_SETTINGS.pricingOverrides),
  };
}

function readCollectorSettings(ctx: PluginContext): CollectorSettings {
  const get = settingsReader(ctx);
  return {
    claudeCode: get('usage.sources.claudeCode', true),
    claudeExtraDirs: get<string[]>('usage.sources.claudeCode.extraDirs', []),
    codex: get('usage.sources.codex', true),
    gemini: get('usage.sources.gemini', true),
    backfillDays: get('usage.backfillDays', 30),
  };
}

const sessionsOf = (agents: AgentSnapshot[]) =>
  agents.filter((a) => a.sessionId).map((a) => ({ sessionId: a.sessionId!, terminalId: a.terminalId }));

/** Usage Monitor backend (docs/plan/08-usage-monitor.md §2): runs the ingest worker and feeds it core state. */
export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
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

  const pushProjects = async () =>
    client.request(
      'setProjects',
      (await oxy.projects.list()).map((p) => ({ id: p.id, rootPath: p.rootPath })),
    );
  await pushProjects();
  await client.request('setAgentSessions', sessionsOf(await oxy.agents.list()));
  let collectorKey = JSON.stringify(readCollectorSettings(ctx));
  await client.request('startCollectors', readCollectorSettings(ctx));

  ctx.subscriptions.push(
    oxy.projects.onDidChange(() => void pushProjects()),
    oxy.agents.onDidChange((agents) => void client.request('setAgentSessions', sessionsOf(agents))),
    oxy.settings.onDidChange('usage.', () => {
      void client.request('setSettings', readSettings(ctx));
      const next = readCollectorSettings(ctx);
      if (JSON.stringify(next) === collectorKey) return;
      collectorKey = JSON.stringify(next);
      void client.request('startCollectors', next);
    }),
  );
}
