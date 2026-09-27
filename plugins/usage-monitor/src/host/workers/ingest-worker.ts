/** Ingest worker (worker_threads inside the Plugin Host): owns the SQLite database and all heavy work. */
import { parentPort, workerData } from 'node:worker_threads';
import { detectUserOtelConfig, type EngineOptions, UsageEngine } from '../engine';
import type { ProjectRef } from '../attribution';
import type { AgentRef } from '../engine';
import type { BudgetInput } from '../analytics/budgets';
import type { CollectorSettings, UsageSettings } from '../settings';
import { serveWorker } from '../worker-rpc';

const PRICING_CHECK_MS = 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const CHANGE_THROTTLE_MS = 1000;

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
  setProjects: async (projects: ProjectRef[]) => (await ready).setProjects(projects),
  setAgents: async (list: AgentRef[]) => (await ready).setAgents(list),
  setActiveProject: async (id: string | null) => {
    (await ready).activeProjectId = id;
  },
  'view.sidebar': async () => (await ready).sidebar(),
  'dash.overview': async () => (await ready).overview(),
  'dash.sessions': async (opts: Parameters<UsageEngine['sessionList']>[0]) => (await ready).sessionList(opts ?? {}),
  'dash.session': async ({ id }: { id: string }) => (await ready).sessionDetail(id),
  'dash.pricing': async () => (await ready).pricingDetail(),
  'dash.sources': async () => (await ready).sources(),
  'view.status': async () => (await ready).status(),
  'budgets.list': async () => (await ready).budgets(),
  'budgets.save': async (input: BudgetInput) => (await ready).saveBudget(input),
  'budgets.delete': async ({ id }: { id: string }) => (await ready).deleteBudget(id),
  /** Live telemetry (§9): starts/stops the receiver; reports a user OpenTelemetry configuration for Claude Code. */
  'otlp.configure': async ({ enabled }: { enabled: boolean }) => {
    const endpoint = await (await ready).configureOtlp(enabled);
    return { endpoint, userConfig: detectUserOtelConfig(process.env) };
  },
  startCollectors: async (options: CollectorSettings) => {
    const e = await ready;
    e.stopCollectors();
    // The initial scan (backfill) continues in the background; progress and changes arrive as events.
    void e.startCollectors(options);
  },
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
  // Throttled change notifications (docs/plan/08-usage-monitor.md §2: `usage:update` at most once per second).
  let pending = false;
  e.onDidChange(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      emit('changed', null);
      for (const alert of e.checkBudgets()) emit('budgetAlert', alert);
    }, CHANGE_THROTTLE_MS);
  });
  e.onProgress((source, done, total) => emit('progress', { source, done, total }));
  e.onSessionLinked((link) => emit('sessionLinked', link));
  setInterval(() => void e.maybeRefreshPricing(), PRICING_CHECK_MS).unref();
  e.applyRetention();
  setInterval(() => e.applyRetention(), RETENTION_MS).unref();
  return e;
});
