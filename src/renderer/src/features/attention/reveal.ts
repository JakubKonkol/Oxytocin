import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { useProjectsStore } from '../../stores/projects-store';
import type { TerminalPanelParams } from '../layout/panel-registry';
import { getWorkspaceApi } from '../layout/workspace-registry';
import { activateProject } from '../projects/project-actions';

function findTerminalPanel(api: DockviewApi, terminalId: string): IDockviewPanel | undefined {
  return api.panels.find((p) => (p.params as Partial<TerminalPanelParams> | undefined)?.terminalId === terminalId);
}

/** Whether the terminal is on screen: its project is active and its panel is the visible tab of its group. */
export function isTerminalVisible(projectId: string, terminalId: string): boolean {
  if (document.visibilityState !== 'visible') return false;
  if (useProjectsStore.getState().activeId !== projectId) return false;
  const api = getWorkspaceApi(projectId);
  const panel = api && findTerminalPanel(api, terminalId);
  if (!api || !panel) return false;
  if (api.hasMaximizedGroup() && !panel.api.isMaximized()) return false;
  return panel.group.activePanel?.id === panel.id;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/** Activates a project and resolves its workspace API once mounted (null after 3 s). */
export async function workspaceFor(projectId: string): Promise<DockviewApi | null> {
  activateProject(projectId);
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const api = getWorkspaceApi(projectId);
    if (api) return api;
    await nextFrame();
  }
  return null;
}

/** Activates the terminal's project and focuses its panel (notification click, "Jump to waiting agent"). */
export async function revealTerminal(projectId: string, terminalId: string): Promise<boolean> {
  activateProject(projectId);
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const api = getWorkspaceApi(projectId);
    const panel = api && findTerminalPanel(api, terminalId);
    if (panel) {
      if (api.hasMaximizedGroup() && !panel.api.isMaximized()) api.exitMaximizedGroup();
      panel.api.setActive();
      return true;
    }
    await nextFrame();
  }
  return false;
}
