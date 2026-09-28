import { describe, expect, it, vi } from 'vitest';
import type { PluginContext, PluginView, ViewProvider } from '@oxytocin/plugin-api';
import { registerUi } from './ui';
import type { WorkerClient } from './worker-rpc';

function setup(status: Record<string, unknown>, settings: Record<string, unknown> = {}) {
  const item = { text: '', tooltip: '', command: undefined as unknown, show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
  const providers = new Map<string, ViewProvider>();
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const update = vi.fn(() => Promise.resolve());
  const ctx = {
    subscriptions: [] as { dispose(): void }[],
    oxy: {
      ui: {
        statusBarItem: () => item,
        registerViewProvider: (id: string, p: ViewProvider) => (providers.set(id, p), { dispose: vi.fn() }),
        registerPanelProvider: (id: string, p: ViewProvider) => (providers.set(id, p), { dispose: vi.fn() }),
        openPanel: vi.fn(() => Promise.resolve()),
        showNotification: vi.fn(),
      },
      settings: { get: (k: string) => settings[k], update, onDidChange: () => ({ dispose: vi.fn() }) },
      commands: {
        register: (id: string, h: (...a: unknown[]) => unknown) => (commands.set(id, h), { dispose: vi.fn() }),
        execute: vi.fn(),
      },
      projects: { list: () => Promise.resolve([]) },
    },
  } as unknown as PluginContext;
  const client = {
    request: vi.fn((method: string) => Promise.resolve(method === 'view.status' ? status : {})),
    onEvent: vi.fn(() => () => undefined),
  } as unknown as WorkerClient;
  registerUi(ctx, client);
  return { item, providers, commands, update, ctx };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Usage Monitor UI glue', () => {
  it('shows today in the status bar with a tooltip and a spinner while busy', async () => {
    const s = setup({
      todayUsd: 4.823,
      weekUsd: 10,
      monthUsd: 20,
      topProjects: [{ name: 'api', usd: 3.1 }],
      approximate: true,
      activeSession: null,
      busy: true,
    });
    await flush();
    expect(s.item.text).toBe('$(graph) ≈$4.82 $(sync~spin)');
    expect(s.item.tooltip).toContain('This week: ≈$10.00');
    expect(s.item.tooltip).toContain('api: $3.10');
    expect(s.item.command).toBe('usage.openDashboard');
    expect(s.item.show).toHaveBeenCalled();
    for (const d of s.ctx.subscriptions) d.dispose();
  });

  it('shows the Claude subscription limits instead of the cost when reported', async () => {
    const s = setup({
      todayUsd: 4.8,
      weekUsd: 10,
      monthUsd: 20,
      topProjects: [],
      approximate: true,
      activeSession: null,
      busy: false,
      subscriptionLimits: [
        { window: 'five_hour', percent: 24, resetsAt: Date.now() + 90 * 60_000 },
        { window: 'seven_day', percent: 41, resetsAt: null },
      ],
    });
    await flush();
    expect(s.item.text).toBe('$(graph) 5h 24% · week 41%');
    expect(s.item.tooltip).toMatch(
      /^Claude 5-hour limit: 24%, resets in 1h 30m\nClaude weekly limit: 41%\n\nToday: ≈\$4\.80/,
    );
    for (const d of s.ctx.subscriptions) d.dispose();
  });

  it('shows tokens instead of API-equivalent costs with subscription billing only', async () => {
    const s = setup({
      todayUsd: 4.8,
      weekUsd: 10,
      monthUsd: 20,
      topProjects: [{ name: 'api', usd: 3.1 }],
      approximate: true,
      activeSession: null,
      busy: false,
      subscriptionLimits: [],
      subscriptionOnly: true,
      tokens: { today: 1_240_000, week: 12_500, month: 950 },
    });
    await flush();
    expect(s.item.text).toBe('$(graph) 1.24M tokens');
    expect(s.item.tooltip).toBe('Today: 1.24M tokens\nThis week: 13k tokens\nThis month: 950 tokens');
    for (const d of s.ctx.subscriptions) d.dispose();
  });

  it('hides the item when turned off and only lets the dashboard change usage settings', async () => {
    const s = setup({ todayUsd: 1 }, { 'usage.statusBar': 'off' });
    await flush();
    expect(s.item.hide).toHaveBeenCalled();
    const handlers = new Map<string, (p: unknown) => unknown>();
    const view = {
      onDidDispose: vi.fn(),
      onDidChangeVisibility: vi.fn(),
      onRequest: (m: string, h: (p: unknown) => unknown) => handlers.set(m, h),
    } as unknown as PluginView;
    await s.providers.get('usage.dashboard')!.resolve(view);
    await handlers.get('settings.set')!({ key: 'usage.costMode', value: 'calculate' });
    expect(s.update).toHaveBeenCalledWith('usage.costMode', 'calculate');
    await expect(
      Promise.resolve(handlers.get('settings.set')!({ key: 'terminal.fontSize', value: 1 })),
    ).rejects.toThrow(/cannot be changed/);
    for (const d of s.ctx.subscriptions) d.dispose();
  });
});
