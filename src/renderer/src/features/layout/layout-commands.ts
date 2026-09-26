import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { registerCommand } from '../../lib/commands';
import { useTerminalsStore } from '../../stores/terminals-store';
import { useProfilePickerStore } from './ProfilePicker';
import type { TerminalPanelParams } from './panel-registry';
import { addTerminalPanel, type PanelPosition, requestClosePanel, restartTerminalPanel } from './workspace-actions';
import { getActiveWorkspace } from './workspace-registry';

const RESIZE_STEP = 0.05;

function activeTerminalInfo(panel: IDockviewPanel | undefined) {
  if (panel?.api.component !== 'terminal') return undefined;
  const id = (panel.params as TerminalPanelParams | undefined)?.terminalId;
  return id ? useTerminalsStore.getState().terminals[id] : undefined;
}

/** Split the active panel: a new terminal with the same profile and cwd (or the project default). */
export async function splitActive(api: DockviewApi, projectId: string, direction: 'right' | 'below'): Promise<void> {
  const panel = api.activePanel;
  const info = activeTerminalInfo(panel);
  const position: PanelPosition | undefined = panel ? { referencePanel: panel.id, direction } : undefined;
  await addTerminalPanel(api, { projectId, ...(info ? { profileId: info.profileId, cwd: info.cwd } : {}) }, position);
}

export async function newTerminal(api: DockviewApi, projectId: string, profileId?: string): Promise<void> {
  const group = api.activeGroup;
  await addTerminalPanel(
    api,
    { projectId, ...(profileId ? { profileId } : {}) },
    group ? { referenceGroup: group } : undefined,
  );
}

export function toggleMaximize(api: DockviewApi): void {
  if (api.hasMaximizedGroup()) {
    api.exitMaximizedGroup();
    return;
  }
  const panel = api.activePanel;
  if (panel && api.groups.length > 1) api.maximizeGroup(panel);
}

export function focusNeighbour(api: DockviewApi, direction: 'left' | 'right' | 'up' | 'down'): void {
  const group = api.activeGroup;
  if (!group) return;
  const next = api.adjacentGroupInDirection(group, direction);
  if (next?.activePanel) next.activePanel.api.setActive();
}

export function resizeActive(api: DockviewApi, direction: 'left' | 'right' | 'up' | 'down'): void {
  const group = api.activeGroup;
  if (!group) return;
  if (direction === 'left' || direction === 'right') {
    const delta = Math.round(api.width * RESIZE_STEP) * (direction === 'right' ? 1 : -1);
    group.api.setSize({ width: Math.max(80, group.width + delta) });
  } else {
    const delta = Math.round(api.height * RESIZE_STEP) * (direction === 'down' ? 1 : -1);
    group.api.setSize({ height: Math.max(60, group.height + delta) });
  }
}

export function cycleTab(api: DockviewApi, step: 1 | -1): void {
  const group = api.activeGroup;
  const panels = group?.panels ?? [];
  if (!group || panels.length < 2) return;
  const index = panels.findIndex((p) => p.id === group.activePanel?.id);
  panels[(index + step + panels.length) % panels.length]?.api.setActive();
}

/** Registers the layout/terminal commands acting on the active workspace. */
export function registerLayoutCommands(): void {
  const withWs = (fn: (api: DockviewApi, projectId: string) => unknown) => () => {
    const ws = getActiveWorkspace();
    if (ws) return fn(ws.api, ws.projectId);
    return undefined;
  };
  registerCommand({
    id: 'terminal.new',
    title: 'Terminal: New Terminal',
    run: withWs((api, p) => newTerminal(api, p)),
  });
  registerCommand({
    id: 'terminal.newWithProfile',
    title: 'Terminal: New Terminal With Profile…',
    run: () => useProfilePickerStore.getState().open(),
  });
  registerCommand({
    id: 'terminal.splitRight',
    title: 'Terminal: Split Right',
    run: withWs((api, p) => splitActive(api, p, 'right')),
  });
  registerCommand({
    id: 'terminal.splitDown',
    title: 'Terminal: Split Down',
    run: withWs((api, p) => splitActive(api, p, 'below')),
  });
  registerCommand({
    id: 'panel.close',
    title: 'View: Close Panel',
    run: withWs((api) => (api.activePanel ? requestClosePanel(api, api.activePanel.id) : undefined)),
  });
  registerCommand({
    id: 'panel.toggleMaximize',
    title: 'View: Toggle Maximized Panel',
    run: withWs((api) => toggleMaximize(api)),
  });
  for (const dir of ['left', 'right', 'up', 'down'] as const) {
    const cap = dir[0]!.toUpperCase() + dir.slice(1);
    registerCommand({
      id: `panel.focus${cap}`,
      title: `View: Focus Panel ${cap}`,
      run: withWs((api) => focusNeighbour(api, dir)),
    });
    registerCommand({
      id: `panel.resize${cap}`,
      title: `View: Resize Panel ${cap}`,
      run: withWs((api) => resizeActive(api, dir)),
    });
  }
  registerCommand({ id: 'panel.nextTab', title: 'View: Next Tab', run: withWs((api) => cycleTab(api, 1)) });
  registerCommand({ id: 'panel.previousTab', title: 'View: Previous Tab', run: withWs((api) => cycleTab(api, -1)) });
  registerCommand({
    id: 'terminal.restart',
    title: 'Terminal: Restart',
    run: withWs((api) => (api.activePanel ? restartTerminalPanel(api, api.activePanel.id) : undefined)),
  });
}
