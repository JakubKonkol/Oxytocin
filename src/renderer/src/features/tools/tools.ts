import {
  type AddPanelPositionOptions,
  type DockviewApi,
  type DockviewGroupPanel,
  getPanelData,
  type IDockviewPanel,
  type PaneTransfer,
  type PaneviewApi,
  type Position,
} from 'dockview-react';
import { useMemo } from 'react';
import { DEFAULT_SIDEBAR_TOOLS, type SidebarTool } from '@shared/domain/ui-state';
import { usePluginsStore } from '../../stores/plugins-store';
import { useUiStore } from '../../stores/ui-store';
import { notify } from '../../ui/Toast';
import { newPanelId } from '../layout/panel-registry';
import { getActiveWorkspace, getWorkspaceApis } from '../layout/workspace-registry';
import { openPluginPanel, type PluginPanelParams } from '../plugins/plugin-panels';
import { viewStates } from '../plugins/view-bridge';

export const SCRATCHPAD_TOOL_ID = 'scratchpad';
export const SCRATCHPAD_PANEL_TITLE = 'Scratchpad';

/** Something the "+" and "Add tool" menus can open: the scratchpad or a plugin panel with `showInAddMenu`. */
export interface ToolDefinition {
  /** `scratchpad` or `plugin:<panelType>`. */
  id: string;
  title: string;
  pluginId?: string;
  panelType?: string;
}

type PanelContribution = ReturnType<typeof usePluginsStore.getState>['contributions']['panels'][number];

export function availableTools(panels: PanelContribution[]): ToolDefinition[] {
  return [
    { id: SCRATCHPAD_TOOL_ID, title: SCRATCHPAD_PANEL_TITLE },
    ...panels
      .filter((p) => p.showInAddMenu)
      .map((p) => ({ id: `plugin:${p.type}`, title: p.title, pluginId: p.pluginId, panelType: p.type }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  ];
}

export function useAvailableTools(): ToolDefinition[] {
  const panels = usePluginsStore((s) => s.contributions.panels);
  return useMemo(() => availableTools(panels), [panels]);
}

const newViewId = () => newPanelId('plg').replace('plg-', 'pv-');

/** Gives a moved plugin view a fresh instance id that carries over its `oxy.setState` state. */
function transferViewState(fromViewId: string): string {
  const viewId = newViewId();
  const state = viewStates.get(fromViewId);
  if (state !== undefined) viewStates.set(viewId, state);
  return viewId;
}

// ---------------------------------------------------------------------------------------------------------------
// Right sidebar

let paneviewApi: PaneviewApi | null = null;

/** Set by the right sidebar when its paneview is ready (null when it unmounts). */
export function setSidebarPaneviewApi(api: PaneviewApi | null): void {
  paneviewApi = api;
}

/**
 * Whether a paneview drag (a section header) carries a right sidebar tool. Tool ids (`scratchpad`, `tool-…`) never
 * collide with the left sidebar's sections (`projects`, `changes`, `plugin:…`).
 */
export function isSidebarToolDrag(data: PaneTransfer | undefined): data is PaneTransfer {
  return !!data && sidebarTools().some((t) => t.id === data.paneId);
}

const sidebarTools = () => useUiStore.getState().state.secondaryTools;

let pendingReveal: string | null = null;

/** Opens the right sidebar, expands the tool and focuses it (the scratchpad's text box). */
export function revealSidebarTool(id: string): void {
  useUiStore.getState().toggleSecondarySidebar(true);
  pendingReveal = id;
  requestAnimationFrame(applyPendingReveal);
}

/** Finishes `revealSidebarTool` once the sidebar (re)mounted and has the tool's section. */
export function applyPendingReveal(): void {
  const id = pendingReveal;
  const pane = id ? paneviewApi?.getPanel(id) : undefined;
  if (!id || !pane) return;
  pendingReveal = null;
  if (!pane.api.isExpanded) pane.api.setExpanded(true);
  if (id === SCRATCHPAD_TOOL_ID)
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('[data-testid="secondary-sidebar"] [data-testid="scratchpad-input"]')
        ?.focus(),
    );
}

/** Adds a tool to the right sidebar (at `index`, default: the bottom); the scratchpad is only there once. */
export function addSidebarTool(tool: SidebarTool, index?: number): void {
  const tools = sidebarTools();
  const existing = tool.kind === 'scratchpad' ? tools.find((t) => t.kind === 'scratchpad') : undefined;
  if (existing) {
    revealSidebarTool(existing.id);
    return;
  }
  const next = [...tools];
  next.splice(index === undefined ? next.length : Math.max(0, Math.min(index, next.length)), 0, tool);
  useUiStore.getState().setSecondaryTools(next);
  revealSidebarTool(tool.id);
}

/** A new sidebar tool for a menu entry. */
export function sidebarToolFor(def: ToolDefinition): SidebarTool {
  if (def.id === SCRATCHPAD_TOOL_ID || !def.pluginId || !def.panelType) return { ...DEFAULT_SIDEBAR_TOOLS[0]! };
  return {
    id: newPanelId('tool'),
    kind: 'plugin',
    pluginId: def.pluginId,
    panelType: def.panelType,
    viewId: newViewId(),
    title: def.title,
  };
}

/** Closes a tool of the right sidebar (a plugin view's saved state goes with it). */
export function closeSidebarTool(id: string): void {
  const tools = sidebarTools();
  const tool = tools.find((t) => t.id === id);
  if (!tool) return;
  useUiStore.getState().setSecondaryTools(tools.filter((t) => t.id !== id));
  if (tool.kind === 'plugin' && useUiStore.getState().state.pluginViewState[tool.viewId] !== undefined)
    useUiStore.getState().setPluginViewState(tool.viewId, undefined);
}

/** A global singleton plugin panel already open in the right sidebar (it is revealed instead of opened twice). */
export function findSidebarPluginTool(panelType: string): SidebarTool | undefined {
  return sidebarTools().find((t) => t.kind === 'plugin' && t.panelType === panelType);
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace

/** Panel components that can move between the workspace and the right sidebar. */
export function isMovableComponent(component: string): boolean {
  return component === 'scratchpad' || component === 'plugin';
}

/** Adds the scratchpad panel to a workspace (or activates the one already there). */
export function openScratchpadPanel(api: DockviewApi, position?: AddPanelPositionOptions): void {
  const existing = api.panels.find((p) => p.api.component === 'scratchpad');
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: newPanelId('tool'),
    component: 'scratchpad',
    title: SCRATCHPAD_PANEL_TITLE,
    ...(position ? { position } : {}),
  });
}

/** Adds a plugin panel for a tool definition or a moved sidebar tool. */
function addPluginPanel(
  api: DockviewApi,
  projectId: string,
  p: { pluginId: string; panelType: string; viewId: string; params?: unknown },
  title: string,
  position?: AddPanelPositionOptions,
): void {
  const params: PluginPanelParams = {
    pluginId: p.pluginId,
    panelType: p.panelType,
    projectId,
    viewId: p.viewId,
    ...(p.params !== undefined ? { params: p.params } : {}),
  };
  api.addPanel<PluginPanelParams>({
    id: newPanelId('plg'),
    component: 'plugin',
    params,
    title,
    ...(position ? { position } : {}),
  });
}

/** Moves a workspace panel (scratchpad or plugin panel) into the right sidebar at `index`. */
export function moveWorkspacePanelToSidebar(api: DockviewApi, panelId: string, index?: number): boolean {
  const panel = api.getPanel(panelId);
  if (!panel) return false;
  if (panel.api.component === 'scratchpad') {
    api.removePanel(panel);
    addSidebarTool({ id: SCRATCHPAD_TOOL_ID, kind: 'scratchpad' }, index);
    return true;
  }
  if (panel.api.component !== 'plugin') return false;
  const p = panel.params as PluginPanelParams;
  const viewId = transferViewState(p.viewId);
  const state = viewStates.get(viewId);
  if (state !== undefined) useUiStore.getState().setPluginViewState(viewId, state);
  const title = panel.title ?? p.panelType;
  api.removePanel(panel);
  addSidebarTool(
    {
      id: newPanelId('tool'),
      kind: 'plugin',
      pluginId: p.pluginId,
      panelType: p.panelType,
      viewId,
      title,
      ...(p.params !== undefined ? { params: p.params } : {}),
    },
    index,
  );
  return true;
}

/** Moves a right sidebar tool into a workspace (default: the active group of the active project). */
export function moveSidebarToolToWorkspace(
  toolId: string,
  target?: { api: DockviewApi; projectId: string; position?: AddPanelPositionOptions },
): boolean {
  const tool = sidebarTools().find((t) => t.id === toolId);
  if (!tool) return false;
  const ws = target ?? getActiveWorkspace();
  if (!ws) {
    notify('info', 'Open a project first');
    return false;
  }
  const position =
    target?.position ??
    (ws.api.activeGroup ? { referenceGroup: ws.api.activeGroup, direction: 'within' as const } : undefined);
  if (tool.kind === 'scratchpad') {
    closeSidebarTool(tool.id);
    openScratchpadPanel(ws.api, position);
  } else {
    const contribution = usePluginsStore
      .getState()
      .contributions.panels.find((p) => p.pluginId === tool.pluginId && p.type === tool.panelType);
    const viewId = transferViewState(tool.viewId);
    if (viewStates.get(viewId) === undefined) {
      const saved = useUiStore.getState().state.pluginViewState[tool.viewId];
      if (saved !== undefined) viewStates.set(viewId, saved);
    }
    closeSidebarTool(tool.id);
    addPluginPanel(
      ws.api,
      ws.projectId,
      { ...tool, viewId },
      tool.title ?? contribution?.title ?? tool.panelType,
      position,
    );
  }
  return true;
}

/** Opens a menu entry in a workspace (next to the group whose "+" was clicked). */
export async function openToolInWorkspace(
  def: ToolDefinition,
  target: { api: DockviewApi; projectId: string; group?: DockviewGroupPanel },
): Promise<void> {
  const position = target.group ? { referenceGroup: target.group, direction: 'within' as const } : undefined;
  if (def.id === SCRATCHPAD_TOOL_ID) {
    openScratchpadPanel(target.api, position);
    return;
  }
  if (!def.panelType) return;
  await openPluginPanel(def.panelType, {
    projectId: target.projectId,
    ...(position ? { position } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Drag and drop

/** The workspace panel a dockview drag carries, when it can move to the right sidebar. */
export function draggedWorkspacePanel(): { api: DockviewApi; panel: IDockviewPanel } | null {
  const data = getPanelData();
  if (!data?.panelId) return null;
  for (const api of getWorkspaceApis()) {
    if (api.id !== data.viewId) continue;
    const panel = api.getPanel(data.panelId);
    return panel && isMovableComponent(panel.api.component) ? { api, panel } : null;
  }
  return null;
}

/** Where a drop on a dockview group puts the new panel. */
export function dropPosition(position: Position, group: DockviewGroupPanel | undefined): AddPanelPositionOptions {
  const direction =
    position === 'top' ? 'above' : position === 'bottom' ? 'below' : position === 'center' ? 'within' : position;
  if (group) return { referenceGroup: group, direction };
  return { direction: direction === 'within' ? 'right' : direction };
}

/**
 * View: Focus Scratchpad — the right sidebar's scratchpad, else the active workspace's scratchpad panel, else a
 * scratchpad added to the right sidebar.
 */
export function focusScratchpad(): void {
  if (sidebarTools().some((t) => t.kind === 'scratchpad')) {
    revealSidebarTool(SCRATCHPAD_TOOL_ID);
    return;
  }
  const panel = getActiveWorkspace()?.api.panels.find((p) => p.api.component === 'scratchpad');
  if (panel) {
    panel.api.setActive();
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-testid="scratchpad-panel"] [data-testid="scratchpad-input"]')?.focus(),
    );
    return;
  }
  addSidebarTool({ id: SCRATCHPAD_TOOL_ID, kind: 'scratchpad' });
}
