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
  // Floating groups are not part of the grid and cannot be maximized.
  if (panel && panel.api.location.type === 'grid' && api.groups.length > 1) api.maximizeGroup(panel);
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

const FLOATING_SIZE = 0.6;

/** Moves a panel into a new floating group centred over the workspace (05 §5, M7-T9). */
export function moveToFloating(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  if (!panel || panel.api.location.type === 'floating') return;
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const width = Math.max(360, Math.round(api.width * FLOATING_SIZE));
  const height = Math.max(220, Math.round(api.height * FLOATING_SIZE));
  api.addFloatingGroup(panel, {
    x: Math.max(0, Math.round((api.width - width) / 2)),
    y: Math.max(0, Math.round((api.height - height) / 2)),
    width,
    height,
  });
  panel.api.setActive();
}

/** Docks a floating panel back into the grid (next to the active grid group, or as the only one). */
export function dockPanel(api: DockviewApi, panelId: string): void {
  const panel = api.getPanel(panelId);
  if (!panel || panel.api.location.type !== 'floating') return;
  const target = api.groups.find((g) => g.api.location.type === 'grid');
  if (target) panel.api.moveTo({ group: target, position: 'center' });
  else panel.api.moveTo({ group: api.addGroup(), position: 'center' });
  panel.api.setActive();
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
  const hasWs = () => getActiveWorkspace() !== null;
  const activeIsTerminal = () => getActiveWorkspace()?.api.activePanel?.api.component === 'terminal';
  registerCommand({
    id: 'terminal.new',
    title: 'Terminal: New Terminal',
    when: hasWs,
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
    when: hasWs,
    run: withWs((api, p) => splitActive(api, p, 'right')),
  });
  registerCommand({
    id: 'terminal.splitDown',
    title: 'Terminal: Split Down',
    when: hasWs,
    run: withWs((api, p) => splitActive(api, p, 'below')),
  });
  registerCommand({
    id: 'panel.close',
    title: 'View: Close Panel',
    when: hasWs,
    run: withWs((api) => (api.activePanel ? requestClosePanel(api, api.activePanel.id) : undefined)),
  });
  registerCommand({
    id: 'panel.toggleMaximize',
    title: 'View: Toggle Maximized Panel',
    when: hasWs,
    run: withWs((api) => toggleMaximize(api)),
  });
  for (const dir of ['left', 'right', 'up', 'down'] as const) {
    const cap = dir[0]!.toUpperCase() + dir.slice(1);
    registerCommand({
      id: `panel.focus${cap}`,
      title: `View: Focus Panel ${cap}`,
      when: hasWs,
      run: withWs((api) => focusNeighbour(api, dir)),
    });
    registerCommand({
      id: `panel.resize${cap}`,
      title: `View: Resize Panel ${cap}`,
      when: hasWs,
      run: withWs((api) => resizeActive(api, dir)),
    });
  }
  const activeLocation = () => getActiveWorkspace()?.api.activePanel?.api.location.type;
  registerCommand({
    id: 'panel.moveToFloating',
    title: 'View: Move Panel to Floating Group',
    when: () => activeLocation() === 'grid',
    run: withWs((api) => (api.activePanel ? moveToFloating(api, api.activePanel.id) : undefined)),
  });
  registerCommand({
    id: 'panel.dock',
    title: 'View: Dock Floating Panel',
    when: () => activeLocation() === 'floating',
    run: withWs((api) => (api.activePanel ? dockPanel(api, api.activePanel.id) : undefined)),
  });
  registerCommand({
    id: 'panel.nextTab',
    title: 'View: Next Tab',
    when: hasWs,
    run: withWs((api) => cycleTab(api, 1)),
  });
  registerCommand({
    id: 'panel.previousTab',
    title: 'View: Previous Tab',
    when: hasWs,
    run: withWs((api) => cycleTab(api, -1)),
  });
  registerCommand({
    id: 'terminal.restart',
    title: 'Terminal: Restart',
    when: activeIsTerminal,
    run: withWs((api) => (api.activePanel ? restartTerminalPanel(api, api.activePanel.id) : undefined)),
  });
}
