import type { DockviewApi, SerializedDockview } from 'dockview-react';
import type { PanelDescriptor, WorkspaceState } from '@shared/domain/workspace';
import { OxyError } from '@shared/errors';
import { ipc } from '../../lib/ipc-client';
import { getSettings } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';
import type { TerminalPanelParams } from './panel-registry';
import type { DiffPanelParams } from '../diff/diff-actions';
import type { PluginPanelParams } from '../plugins/plugin-panels';
import { viewStates } from '../plugins/view-bridge';
import { addExistingTerminalPanel, addTerminalPanel, type PanelPosition } from './workspace-actions';
import { useProjectsStore } from '../../stores/projects-store';
import { changesUi, useChangesStore } from '../../stores/changes-store';
import { usePluginsStore } from '../../stores/plugins-store';

const KNOWN_COMPONENTS = new Set(['terminal', 'diff', 'plugin', 'missing', 'plugins']);
const SAVE_DEBOUNCE_MS = 1000;

/** Builds the persisted state: dockview JSON + a descriptor per panel (enough to revive terminals). */
export function buildWorkspaceState(api: DockviewApi, projectId: string): WorkspaceState {
  const terminals = useTerminalsStore.getState().terminals;
  const panels: Record<string, PanelDescriptor> = {};
  for (const panel of api.panels) {
    if (panel.api.component === 'terminal') {
      const terminalId = (panel.params as TerminalPanelParams | undefined)?.terminalId;
      const info = terminalId ? terminals[terminalId] : undefined;
      if (!info) continue;
      panels[panel.id] = {
        kind: 'terminal',
        terminalId: info.id,
        profileId: info.profileId,
        cwd: info.cwd,
        ...(info.userTitle ? { userTitle: info.userTitle } : {}),
      };
    } else if (panel.api.component === 'diff') {
      const p = panel.params as DiffPanelParams | undefined;
      if (p)
        panels[panel.id] = {
          kind: 'diff',
          path: p.path,
          ...(p.oldPath ? { oldPath: p.oldPath } : {}),
          pinned: !p.preview,
        };
    } else if (panel.api.component === 'plugin') {
      const p = panel.params as PluginPanelParams | undefined;
      if (p) {
        const state = viewStates.get(p.viewId);
        panels[panel.id] = {
          kind: 'plugin',
          pluginId: p.pluginId,
          panelType: p.panelType,
          params: { viewId: p.viewId, params: p.params },
          ...(state !== undefined ? { state } : {}),
        };
      }
    } else if (panel.api.component === 'missing') {
      const descriptor = (panel.params as { descriptor?: PanelDescriptor } | undefined)?.descriptor;
      if (descriptor) panels[panel.id] = descriptor;
    }
  }
  return {
    version: 1,
    projectId,
    savedAt: Date.now(),
    dockview: api.toJSON() as unknown as Record<string, unknown>,
    panels,
    ...(api.activePanel ? { activePanelId: api.activePanel.id } : {}),
    ui: { changes: persistedChangesUi(projectId) },
  };
}

function persistedChangesUi(projectId: string): NonNullable<WorkspaceState['ui']['changes']> {
  const ui = changesUi(projectId);
  return { expanded: ui.expanded, mode: ui.mode, ...(ui.filter ? { filter: ui.filter } : {}) };
}

const flushers = new Map<string, () => Promise<void>>();

/** Called by main before quitting (executeJavaScript) so the latest layout is on disk. */
export async function flushAllWorkspaces(): Promise<void> {
  await Promise.all([...flushers.values()].map((f) => f()));
}

/** Debounced saving of a workspace; returns a disposer. */
export function trackWorkspacePersistence(api: DockviewApi, projectId: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let enabled = true;
  const save = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!enabled) return;
    await ipc.invoke('workspace:save', buildWorkspaceState(api, projectId));
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };
  const layoutSub = api.onDidLayoutChange(schedule);
  const activeSub = api.onDidActivePanelChange(schedule);
  // Titles and cwd live in TerminalInfo; persist their changes too.
  const unsubscribeStore = useTerminalsStore.subscribe((s, prev) => {
    if (s.terminals !== prev.terminals) schedule();
  });
  // Expanded folders, view mode and filter of the CHANGES section (per project).
  const unsubscribeChanges = useChangesStore.subscribe((s, prev) => {
    const a = s.ui[projectId];
    const b = prev.ui[projectId];
    if (a !== b && (a?.expanded !== b?.expanded || a?.mode !== b?.mode || a?.filter !== b?.filter)) schedule();
  });
  flushers.set(projectId, save);
  return () => {
    // Evicted (LRU) or unmounted: write the latest layout so rehydration starts from it.
    if (timer) void save();
    enabled = false;
    if (timer) clearTimeout(timer);
    layoutSub.dispose();
    activeSub.dispose();
    unsubscribeStore();
    unsubscribeChanges();
    flushers.delete(projectId);
  };
}

type SerializedPanels = SerializedDockview['panels'];

/**
 * Restores a saved workspace: live terminals (renderer reload) are reused, dead ones are re-created with the
 * same profile/cwd and their scrollback; unknown panel types become "missing" placeholders.
 * Returns false when there was nothing (usable) to restore.
 */
export async function restoreWorkspace(api: DockviewApi, projectId: string): Promise<boolean> {
  const { state, problem } = await ipc.invoke('workspace:load', { projectId });
  if (problem) notify('warning', problem);
  if (state?.ui.changes && !useChangesStore.getState().ui[projectId]) {
    const { expanded, mode, filter } = state.ui.changes;
    useChangesStore.getState().setUi(projectId, { expanded, mode, filter: filter ?? '' });
  }
  if (!state || !getSettings()['workspace.restoreOnStartup']) return false;
  const json = structuredClone(state.dockview) as unknown as SerializedDockview;
  const serializedPanels: SerializedPanels = json.panels ?? {};
  const live = useTerminalsStore.getState().terminals;
  const used = new Set<string>();

  for (const [panelId, panel] of Object.entries(serializedPanels)) {
    const descriptor = state.panels[panelId];
    const component = panel.contentComponent ?? '';
    if (component === 'terminal' && descriptor?.kind === 'terminal') {
      if (descriptor.terminalId && live[descriptor.terminalId]?.projectId === projectId) {
        used.add(descriptor.terminalId);
        continue;
      }
      const request = {
        projectId,
        profileId: descriptor.profileId,
        cwd: descriptor.cwd,
        ...(descriptor.userTitle ? { userTitle: descriptor.userTitle } : {}),
        ...(descriptor.scrollbackFile ? { restoreScrollback: { panelId } } : {}),
      };
      let info;
      try {
        info = await ipc.invoke('terminals:create', request);
      } catch (e) {
        // The profile may no longer exist — fall back to the default profile.
        if (!(e instanceof OxyError) || e.code !== 'NOT_FOUND') throw e;
        const { profileId: _p, ...rest } = request;
        info = await ipc.invoke('terminals:create', rest);
      }
      useTerminalsStore.getState().upsert(info);
      used.add(info.id);
      panel.params = { ...panel.params, terminalId: info.id };
    } else if (component === 'plugin') {
      const available =
        descriptor?.kind === 'plugin' &&
        usePluginsStore
          .getState()
          .contributions.panels.some((p) => p.pluginId === descriptor.pluginId && p.type === descriptor.panelType);
      if (!available) {
        const pluginId = descriptor?.kind === 'plugin' ? descriptor.pluginId : 'unknown';
        panel.contentComponent = 'missing';
        panel.params = { reason: `Plugin "${pluginId}" is unavailable`, ...(descriptor ? { descriptor } : {}) };
        continue;
      }
      // View state saved at quit comes back through oxy:init.state.
      const viewId = (panel.params as Partial<PluginPanelParams> | undefined)?.viewId;
      if (viewId && descriptor.state !== undefined) viewStates.set(viewId, descriptor.state);
    } else if (!KNOWN_COMPONENTS.has(component)) {
      panel.contentComponent = 'missing';
      panel.params = {
        reason: `Panel type "${component}" is unavailable`,
        ...(descriptor ? { descriptor } : {}),
      };
    }
  }
  try {
    api.fromJSON(json);
  } catch (e) {
    notify('warning', 'The saved layout could not be restored. A default layout was opened.', {
      description: e instanceof Error ? e.message : String(e),
    });
    api.clear();
    return false;
  }
  if (state.activePanelId) api.getPanel(state.activePanelId)?.api.setActive();
  // Terminals alive in main but absent from the saved layout (e.g. created right before a reload).
  for (const t of Object.values(useTerminalsStore.getState().terminals)) {
    if (t.projectId === projectId && !used.has(t.id)) addExistingTerminalPanel(api, t.id, t.title);
  }
  return api.panels.length > 0;
}

/**
 * First open of a project: its existing terminals, else the project's startup terminals
 * (`settings.startupTerminals`), else one terminal with the project's default profile.
 */
export async function openDefaultLayout(api: DockviewApi, projectId: string): Promise<void> {
  const existing = Object.values(useTerminalsStore.getState().terminals).filter((t) => t.projectId === projectId);
  if (existing.length > 0) {
    for (const t of existing) addExistingTerminalPanel(api, t.id, t.title);
    return;
  }
  const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
  const defaultProfileId = project?.settings.defaultProfileId;
  const startup = project?.settings.startupTerminals ?? [];
  if (startup.length === 0) {
    await addTerminalPanel(api, { projectId, ...(defaultProfileId ? { profileId: defaultProfileId } : {}) });
    return;
  }
  let previous: string | null = null;
  for (const task of startup) {
    const profileId = task.profileId ?? defaultProfileId;
    const position: PanelPosition | undefined =
      previous && task.placement && task.placement !== 'tab'
        ? { referencePanel: previous, direction: task.placement === 'right' ? 'right' : 'below' }
        : undefined;
    previous =
      (await addTerminalPanel(
        api,
        {
          projectId,
          ...(profileId ? { profileId } : {}),
          ...(task.cwd && project ? { cwd: joinPath(project.rootPath, task.cwd) } : {}),
          ...(task.name ? { userTitle: task.name } : {}),
          ...(task.command ? { initialCommand: task.command } : {}),
        },
        position,
      )) ?? previous;
  }
}

function joinPath(root: string, relative: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${relative.replace(/^[\\/]+/, '')}`;
}
