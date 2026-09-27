import type { PluginContext, PluginView } from '@oxytocin/plugin-api';
import type { WorkerClient } from './worker-rpc';

/** `usage.*` settings the dashboard can edit (Sources / Pricing / Budgets tabs). */
export const EDITABLE_SETTINGS = [
  'usage.sources.claudeCode',
  'usage.sources.codex',
  'usage.sources.gemini',
  'usage.liveTelemetry.claudeCode',
  'usage.liveTelemetry.gemini',
  'usage.liveTelemetry.scope',
  'usage.costMode',
  'usage.billing.claudeCode',
  'usage.billing.codex',
  'usage.billing.gemini',
  'usage.pricing.autoUpdate',
  'usage.pricing.overrides',
  'usage.limits.claudeBlock',
  'usage.backfillDays',
  'usage.retentionDays',
  'usage.statusBar',
  'usage.weekStartsOn',
] as const;

export interface DashboardTarget {
  tab?: 'overview' | 'sessions' | 'budgets' | 'pricing' | 'sources';
  sessionId?: string;
}

const REFRESH_MS = 30_000;

interface StatusModel {
  todayUsd: number;
  weekUsd: number;
  monthUsd: number;
  topProjects: { name: string; usd: number }[];
  approximate: boolean;
  activeSession: { costUsd: number; agent: string } | null;
  busy: boolean;
}

const usd = (v: number) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

/**
 * The Usage Monitor's UI (docs/plan/08-usage-monitor.md §14): sidebar card, dashboard panel, status bar item and
 * commands. Views are "dumb": the backend sends ready models and answers their requests from the worker.
 */
export function registerUi(ctx: PluginContext, client: WorkerClient): void {
  const { oxy } = ctx;
  const sidebars = new Set<PluginView>();
  const dashboards = new Set<PluginView>();

  const pushSidebars = async () => {
    const visible = [...sidebars].filter((v) => v.visible);
    if (visible.length === 0) return;
    const model = await client.request('view.sidebar');
    for (const v of visible) void v.postMessage({ type: 'model', model });
  };

  const status = oxy.ui.statusBarItem('usage.today');
  status.command = 'usage.openDashboard';
  const updateStatus = async () => {
    const mode = oxy.settings.get<string>('usage.statusBar') ?? 'today';
    if (mode === 'off') return status.hide();
    const m = await client.request<StatusModel>('view.status');
    const approx = m.approximate ? '≈' : '';
    const value = mode === 'activeSession' && m.activeSession ? m.activeSession.costUsd : m.todayUsd;
    status.text = `$(graph) ${approx}${usd(value)}${m.busy ? ' $(sync~spin)' : ''}`;
    status.tooltip = [
      `Today: ${approx}${usd(m.todayUsd)}`,
      `This week: ${approx}${usd(m.weekUsd)}`,
      `This month: ${approx}${usd(m.monthUsd)}`,
      ...(m.topProjects.length > 0 ? ['', ...m.topProjects.map((p) => `${p.name}: ${usd(p.usd)}`)] : []),
    ].join('\n');
    status.show();
  };

  const openDashboard = async (target: DashboardTarget = {}) => {
    await oxy.ui.openPanel('usage.dashboard', { params: target });
    for (const v of dashboards) void v.postMessage({ type: 'navigate', ...target });
  };

  const refresh = () => {
    void pushSidebars().catch(() => undefined);
    void updateStatus().catch(() => undefined);
  };
  client.onEvent((event, payload) => {
    if (event === 'changed') {
      refresh();
      for (const v of dashboards) void v.postMessage({ type: 'changed' });
    }
    if (event === 'progress')
      for (const v of [...sidebars, ...dashboards]) void v.postMessage({ type: 'progress', ...(payload as object) });
  });
  // Time-based values (burn rate, "live" windows, block reset) move without new events.
  const timer = setInterval(refresh, REFRESH_MS);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  ctx.subscriptions.push(oxy.settings.onDidChange('usage.', refresh));
  refresh();

  const focusTerminal = ({ terminalId }: { terminalId: string }) =>
    oxy.commands.execute('oxytocin.terminal.focus', terminalId);

  ctx.subscriptions.push(
    oxy.ui.registerViewProvider('usage.sidebar', {
      resolve(view) {
        sidebars.add(view);
        view.onDidDispose(() => sidebars.delete(view));
        view.onDidChangeVisibility((visible) => {
          if (visible) void pushSidebars();
        });
        view.onRequest('model', () => client.request('view.sidebar'));
        view.onRequest('sources', () => client.request('dash.sources'));
        view.onRequest<DashboardTarget, void>('openDashboard', (target) => openDashboard(target ?? {}));
        view.onRequest('focusTerminal', focusTerminal);
        view.onRequest('refreshPricing', () => client.request('pricing.refresh'));
      },
    }),
    oxy.ui.registerPanelProvider('usage.dashboard', {
      resolve(view) {
        dashboards.add(view);
        view.onDidDispose(() => dashboards.delete(view));
        view.title = 'Usage';
        view.onRequest('overview', () => client.request('dash.overview'));
        view.onRequest('sessions', (opts) => client.request('dash.sessions', opts));
        view.onRequest<{ id: string }, unknown>('session', ({ id }) => client.request('dash.session', { id }));
        view.onRequest('budgets', () => client.request('budgets.list'));
        view.onRequest('budget.save', (input) => client.request('budgets.save', input));
        view.onRequest<{ id: string }, unknown>('budget.delete', ({ id }) => client.request('budgets.delete', { id }));
        view.onRequest('pricing', () => client.request('dash.pricing'));
        view.onRequest('pricing.refresh', () => client.request('pricing.refresh'));
        view.onRequest('sources', () => client.request('dash.sources'));
        view.onRequest('settings', () => Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, oxy.settings.get(k)])));
        view.onRequest<{ key: string; value: unknown }, void>('settings.set', async ({ key, value }) => {
          if (!(EDITABLE_SETTINGS as readonly string[]).includes(key)) throw new Error(`${key} cannot be changed here`);
          await oxy.settings.update(key, value);
        });
        view.onRequest('focusTerminal', focusTerminal);
        view.onRequest('projects', async () => (await oxy.projects.list()).map((p) => ({ id: p.id, name: p.name })));
      },
    }),
    oxy.commands.register('usage.openDashboard', (target?: unknown) =>
      openDashboard(typeof target === 'object' && target !== null ? target : {}),
    ),
    oxy.commands.register('usage.refreshPricing', async () => {
      const result = await client.request<string>('pricing.refresh');
      void oxy.ui.showNotification({
        level: result === 'failed' ? 'warning' : 'info',
        message: result === 'failed' ? 'Prices could not be refreshed' : 'Prices are up to date',
      });
    }),
  );
}
