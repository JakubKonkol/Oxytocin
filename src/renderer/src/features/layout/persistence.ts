import type { DockviewApi, SerializedDockview } from 'dockview-react';
import type { PanelDescriptor, WorkspaceState } from '@shared/domain/workspace';
import { OxyError } from '@shared/errors';
import { ipc } from '../../lib/ipc-client';
import { getSettings } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';
import type { TerminalPanelParams } from './panel-registry';
import { addExistingTerminalPanel, addTerminalPanel } from './workspace-actions';

const KNOWN_COMPONENTS = new Set(['terminal', 'missing']);
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
    ui: {},
  };
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
  flushers.set(projectId, save);
  return () => {
    enabled = false;
    if (timer) clearTimeout(timer);
    layoutSub.dispose();
    activeSub.dispose();
    unsubscribeStore();
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

export async function openDefaultLayout(api: DockviewApi, projectId: string): Promise<void> {
  const existing = Object.values(useTerminalsStore.getState().terminals).filter((t) => t.projectId === projectId);
  if (existing.length > 0) {
    for (const t of existing) addExistingTerminalPanel(api, t.id, t.title);
    return;
  }
  await addTerminalPanel(api, { projectId });
}
