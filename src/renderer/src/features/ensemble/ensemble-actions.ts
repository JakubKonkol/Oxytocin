import type { AddPanelPositionOptions, DockviewApi } from 'dockview-react';
import { registerCommand } from '../../lib/commands';
import { useProjectsStore } from '../../stores/projects-store';
import { notify } from '../../ui/Toast';
import { getActiveWorkspace, getWorkspaceApi } from '../layout/workspace-registry';
import { workspaceFor } from '../attention/reveal';
import { ipc } from '../../lib/ipc-client';
import { useEnsembleStore } from './ensemble-store';
import { getActiveTerminalId } from '../terminals/terminal-actions';
import { terminalRegistry } from '../terminals/terminal-registry';

export const ENSEMBLE_TOOL_ID = 'ensemble';
export const ENSEMBLE_PANEL_TITLE = 'Ensemble';
const panelId = (projectId: string) => `ensemble-${projectId}`.slice(0, 80);

/** Opens (or activates) the Ensemble panel of a workspace; one per workspace. */
export function openEnsemblePanel(api: DockviewApi, projectId: string, position?: AddPanelPositionOptions): void {
  const existing = api.panels.find((p) => p.api.component === 'ensemble');
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: panelId(projectId),
    component: 'ensemble',
    title: ENSEMBLE_PANEL_TITLE,
    params: { projectId },
    ...(position ? { position } : {}),
  });
}

/** Ensemble of the active project (command palette, status bar, notifications). */
export async function showEnsemble(projectId?: string, taskId?: string): Promise<void> {
  const id = projectId ?? useProjectsStore.getState().activeId;
  if (!id) {
    notify('info', 'Open a project first');
    return;
  }
  const api = projectId ? await workspaceFor(id) : (getActiveWorkspace()?.api ?? (await workspaceFor(id)));
  if (!api) return;
  openEnsemblePanel(api, id);
  if (taskId) useEnsembleStore.getState().select(id, taskId);
}

/** Whether the user looks at this task in an Ensemble panel right now. */
export function isEnsembleVisible(projectId: string, taskId: string): boolean {
  if (document.visibilityState !== 'visible') return false;
  if (useProjectsStore.getState().activeId !== projectId) return false;
  const api = getWorkspaceApi(projectId);
  const panel = api?.panels.find((p) => p.api.component === 'ensemble');
  if (!panel || panel.group.activePanel?.id !== panel.id) return false;
  return useEnsembleStore.getState().selected[projectId] === taskId;
}

export function registerEnsembleCommands(): void {
  registerCommand({ id: 'ensemble.open', title: 'Ensemble: Open', run: () => showEnsemble() });
  registerCommand({
    id: 'ensemble.newTask',
    title: 'Ensemble: New Task',
    when: () => useProjectsStore.getState().activeId !== null,
    run: async () => {
      const projectId = useProjectsStore.getState().activeId;
      if (!projectId) return;
      await showEnsemble(projectId);
      useEnsembleStore.getState().select(projectId, null);
      window.dispatchEvent(new CustomEvent('oxy:ensemble-new-task', { detail: { projectId } }));
    },
  });
  registerCommand({
    id: 'ensemble.newTaskFromSelection',
    title: 'Ensemble: New Task from Selection',
    when: () => useProjectsStore.getState().activeId !== null,
    run: async () => {
      const projectId = useProjectsStore.getState().activeId;
      if (!projectId) return;
      const terminalId = getActiveTerminalId();
      const fromTerminal = terminalId ? (terminalRegistry.get(terminalId)?.term.getSelection() ?? '') : '';
      const text = (fromTerminal || window.getSelection()?.toString() || '').trim();
      if (!text) {
        notify('info', 'Select text first (in a terminal or the scratchpad)');
        return;
      }
      const title = text.split('\n')[0]!.slice(0, 80);
      try {
        const record = await ipc.invoke('ensemble:create', {
          projectId,
          templateId: 'feature',
          title,
          description: text,
        });
        useEnsembleStore.getState().upsert(record);
        useEnsembleStore.getState().setTab(record.task.id, 'task');
        await showEnsemble(projectId, record.task.id);
      } catch (e) {
        notify('error', 'The task could not be created', { description: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  ipc.on('ensemble:open', ({ projectId, taskId }) => void showEnsemble(projectId, taskId));
  ipc.on('ensemble:notify', ({ title, body, level, projectId, taskId }) => {
    if (isEnsembleVisible(projectId, taskId)) return;
    notify(level === 'info' ? 'success' : level, title, {
      description: body,
      id: `ensemble-${taskId}`,
      action: { label: 'Show', onClick: () => void showEnsemble(projectId, taskId) },
    });
  });
}
