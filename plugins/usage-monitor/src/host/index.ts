import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { AgentSnapshot, PluginContext } from '@oxytocin/plugin-api';
import { type CollectorSettings, DEFAULT_SETTINGS, type TelemetrySettings, type UsageSettings } from './settings';
import { applyTelemetryEnv, type OtlpEndpointInfo } from './telemetry-env';
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

function readTelemetrySettings(ctx: PluginContext): TelemetrySettings {
  const get = settingsReader(ctx);
  return {
    claudeCode: get('usage.liveTelemetry.claudeCode', false),
    gemini: get('usage.liveTelemetry.gemini', false),
    scope: get<TelemetrySettings['scope']>('usage.liveTelemetry.scope', 'agentProfiles'),
  };
}

const agentRefs = (agents: AgentSnapshot[]) =>
  agents.map((a) => ({
    terminalId: a.terminalId,
    agentId: a.agentId,
    projectId: a.projectId,
    since: a.since,
    ...(a.sessionId ? { sessionId: a.sessionId } : {}),
    ...(a.cwd ? { cwd: a.cwd } : {}),
  }));

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
    // A Codex/Gemini session file was matched to the agent in a terminal: tell the core (§6).
    if (event === 'sessionLinked') {
      const link = payload as { terminalId: string; sessionId: string };
      oxy.agents.reportSession(link.terminalId, { sessionId: link.sessionId, source: 'usage-monitor' });
    }
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
  await client.request('setAgents', agentRefs(await oxy.agents.list()));
  let collectorKey = JSON.stringify(readCollectorSettings(ctx));
  await client.request('startCollectors', readCollectorSettings(ctx));

  // Live telemetry (opt-in): the receiver runs in the worker, the variables go through the environment collection.
  const configureTelemetry = async () => {
    const telemetry = readTelemetrySettings(ctx);
    const { endpoint, userConfig } = await client.request<{
      endpoint: OtlpEndpointInfo | null;
      userConfig: string | null;
    }>('otlp.configure', { enabled: telemetry.claudeCode || telemetry.gemini });
    if (telemetry.claudeCode && userConfig)
      ctx.log.warn(`Your OpenTelemetry configuration was detected (${userConfig}) — live mode for Claude Code is off.`);
    applyTelemetryEnv(oxy.terminals.environment, endpoint, telemetry, userConfig);
  };
  let telemetryKey = JSON.stringify(readTelemetrySettings(ctx));
  await configureTelemetry();

  ctx.subscriptions.push(
    oxy.projects.onDidChange(() => void pushProjects()),
    oxy.agents.onDidChange((agents) => void client.request('setAgents', agentRefs(agents))),
    oxy.settings.onDidChange('usage.', () => {
      void client.request('setSettings', readSettings(ctx));
      const telemetry = JSON.stringify(readTelemetrySettings(ctx));
      if (telemetry !== telemetryKey) {
        telemetryKey = telemetry;
        void configureTelemetry();
      }
      const next = readCollectorSettings(ctx);
      if (JSON.stringify(next) === collectorKey) return;
      collectorKey = JSON.stringify(next);
      void client.request('startCollectors', next);
    }),
  );
}
