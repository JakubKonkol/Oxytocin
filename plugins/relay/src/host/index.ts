import type { PluginContext, PluginView, ProjectInfo } from '@oxytocin/plugin-api';
import type { RelayConfig, RelayViewState } from '../shared/types';
import { type GitSnapshot, RelayEngine } from './engine';

export const PANEL_TYPE = 'relay.panel';
const configKey = (projectId: string) => `config:${projectId}`;

/** Relay backend: follows the agents, their states and limits, and hands work over as the engine decides. */
export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
  const views = new Set<PluginView>();
  let projects: ProjectInfo[] = await oxy.projects.list();
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '';

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const post = (projectId: string) => {
    // Coalesced: agent states change often, the view needs the latest only.
    if (timers.has(projectId)) return;
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        const state = engine.view(projectId, projectName(projectId));
        for (const view of views) {
          if (view.projectId !== projectId) continue;
          view.badge = state.pending
            ? { text: '…', tone: 'warning' }
            : state.config.enabled
              ? { text: 'on', tone: 'neutral' }
              : undefined;
          void view.postMessage(state);
        }
      }, 100),
    );
  };

  const engine = new RelayEngine({
    send: (terminalId, text) => oxy.agents.sendPrompt(terminalId, text),
    async gitSnapshot(projectId): Promise<GitSnapshot | null> {
      const status = await oxy.git.getStatus(projectId);
      if (!status) return null;
      return new Map(status.files.map((f) => [f.path, `${f.status}:${f.additions ?? ''}:${f.deletions ?? ''}`]));
    },
    notify: (projectId, level, text) => {
      const name = projectName(projectId);
      void oxy.ui.showNotification({ level, message: `Relay${name ? ` (${name})` : ''}: ${text}` });
    },
    changed: post,
  });
  ctx.subscriptions.push({ dispose: () => engine.dispose() });

  const loadConfigs = () => {
    for (const p of projects) {
      const stored = ctx.storage.get<Partial<RelayConfig>>(configKey(p.id));
      if (stored) engine.setConfig(p.id, stored);
    }
  };
  loadConfigs();
  engine.setAccounts(await oxy.agents.listAccounts());
  engine.setLimits(await oxy.agents.getLimits());
  engine.update(await oxy.agents.list());

  const projectOf = async (view: PluginView): Promise<string> =>
    view.projectId ?? (await oxy.projects.getActive())?.id ?? projects[0]?.id ?? '';
  const state = async (view: PluginView): Promise<RelayViewState> => {
    const id = await projectOf(view);
    return engine.view(id, projectName(id));
  };

  ctx.subscriptions.push(
    oxy.agents.onDidChange((agents) => engine.update(agents)),
    oxy.agents.onDidChangeLimits((limits) => engine.setLimits(limits)),
    oxy.agents.onDidChangeAccounts((accounts) => engine.setAccounts(accounts)),
    oxy.projects.onDidChange((list) => {
      projects = list;
      loadConfigs();
    }),
    oxy.ui.registerPanelProvider(PANEL_TYPE, {
      resolve(view) {
        views.add(view);
        view.onDidDispose(() => views.delete(view));
        view.onRequest('load', () => state(view));
        view.onRequest<Partial<RelayConfig>, RelayViewState>('config.set', async (patch) => {
          const id = await projectOf(view);
          // Ids of agents that no longer run are dropped when the configuration is saved.
          const running = new Set(engine.view(id, '').participants.map((p) => p.terminalId));
          const merged = { ...engine.config(id), ...patch };
          const next = engine.setConfig(id, {
            ...merged,
            order: merged.order.filter((t) => running.has(t)),
            excluded: merged.excluded.filter((t) => running.has(t)),
            reviewer: merged.reviewer && running.has(merged.reviewer) ? merged.reviewer : null,
          });
          await ctx.storage.set(configKey(id), next);
          return engine.view(id, projectName(id));
        });
        view.onRequest<{ terminalId: string }, { ok: boolean; error?: string }>('sendNow', async ({ terminalId }) =>
          engine.sendNow(await projectOf(view), terminalId),
        );
      },
    }),
    oxy.commands.register('relay.show', () => oxy.ui.openPanel(PANEL_TYPE, { placement: 'right' })),
  );
}
