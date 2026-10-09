import {
  getPaneData,
  type IPaneviewPanelProps,
  type PaneviewApi,
  type PaneviewDidDropEvent,
  PaneviewReact,
  type PaneviewReadyEvent,
} from 'dockview-react';
import { useEffect, useRef, useState } from 'react';
import type { PaneviewState } from '@shared/domain/ui-state';
import { Plus } from 'lucide-react';
import { SectionHeader } from '../ui/Section';
import { IconButton } from '../ui/IconButton';
import { ProjectsSection } from '../features/projects/ProjectsSection';
import { ChangesCount, ChangesHeaderActions, ChangesSection } from '../features/changes/ChangesSection';
import { FilesHeaderActions, FilesSection } from '../features/editor/FilesSection';
import { registerCommand } from '../lib/commands';
import { addProjectViaDialog } from '../features/projects/project-actions';
import { useProjectsStore } from '../stores/projects-store';
import { useUiStore } from '../stores/ui-store';
import { usePluginsStore } from '../stores/plugins-store';
import { type PluginPaneParams, PluginSidebarView, sidebarViewInstanceId } from '../features/plugins/PluginSidebarView';
import { usePluginViewMeta } from '../features/plugins/view-meta-store';
import { shieldIframesWhileDragging } from '../features/layout/drag-shield';
import {
  applyPendingReveal,
  draggedWorkspacePanel,
  moveSidebarToolToSide,
  moveWorkspacePanelToSidebar,
  setSidebarPaneviewApi,
  takePendingLeftIndex,
} from '../features/tools/tools';
import { addToolPane, TOOL_COMPONENTS, ToolActions, type ToolPaneParams, toolDraggedFrom } from './sidebar-tools';

export const SIDEBAR_HEADER_SIZE = 30;
const TOOL_DEFAULT_SIZE = 300;

interface SectionDefinition {
  id: string;
  title: string;
  size: number;
  order: number;
  /** Starts collapsed until the user expands it. */
  collapsedByDefault?: boolean;
}

/** Core sidebar sections; plugin views are inserted by their `order`. */
const CORE_SECTIONS: SectionDefinition[] = [
  { id: 'projects', title: 'PROJECTS', size: 200, order: 0 },
  { id: 'changes', title: 'CHANGES', size: 380, order: 100 },
  { id: 'files', title: 'FILES', size: 320, order: 150, collapsedByDefault: true },
];

const pluginPaneId = (pluginId: string, viewId: string) => `plugin:${pluginId}:${viewId}`;

function ProjectsHeaderActions() {
  return (
    <IconButton
      label="Add project"
      shortcut="Ctrl+Shift+A"
      icon={<Plus size={14} />}
      onClick={() => void addProjectViaDialog()}
    />
  );
}

function ProjectsCount() {
  const count = useProjectsStore((s) => s.projects.length);
  return count > 0 ? <>{count}</> : null;
}

function PluginPaneBadge({ instanceId }: { instanceId: string }) {
  const badge = usePluginViewMeta((s) => s.meta[instanceId]?.badge);
  if (!badge) return null;
  return <>{badge.text}</>;
}

function PaneHeader(props: IPaneviewPanelProps) {
  const [expanded, setExpanded] = useState(props.api.isExpanded);
  useEffect(() => {
    const d = props.api.onDidExpansionChange((e) => setExpanded(e.isExpanded));
    return () => d.dispose();
  }, [props.api]);
  const plugin = props.params as Partial<PluginPaneParams & ToolPaneParams> | undefined;
  const extras = plugin?.toolId
    ? { actions: <ToolActions toolId={plugin.toolId} side="left" /> }
    : plugin?.pluginId && plugin.viewId
      ? { count: <PluginPaneBadge instanceId={sidebarViewInstanceId(plugin.pluginId, plugin.viewId)} /> }
      : props.api.id === 'projects'
        ? { actions: <ProjectsHeaderActions />, count: <ProjectsCount /> }
        : props.api.id === 'changes'
          ? { actions: <ChangesHeaderActions />, count: <ChangesCount /> }
          : props.api.id === 'files'
            ? { actions: <FilesHeaderActions /> }
            : {};
  return (
    <SectionHeader
      testId={`section-header-${props.api.id}`}
      title={props.title}
      expanded={expanded}
      onToggle={() => props.api.setExpanded(!expanded)}
      {...extras}
    />
  );
}

const components = {
  ...TOOL_COMPONENTS,
  'plugin-view': PluginSidebarView,
  projects: () => <ProjectsSection />,
  changes: () => <ChangesSection />,
  files: () => <FilesSection />,
};

function readPaneviewState(api: PaneviewApi): PaneviewState {
  const panels = api.panels;
  return {
    order: panels.map((p) => p.id),
    sizes: Object.fromEntries(panels.filter((p) => p.api.isExpanded).map((p) => [p.id, Math.round(p.height)])),
    collapsed: panels.filter((p) => !p.api.isExpanded).map((p) => p.id),
    hidden: [],
  };
}

/** Left column: a Paneview of collapsible, resizable, reorderable section cards. */
/** Adds/removes plugin view panes when contributions change; saved order first, then `order`. */
function usePluginPanes(api: PaneviewApi | null, saved: PaneviewState): void {
  const views = usePluginsStore((s) => s.contributions.views);
  useEffect(() => {
    if (!api) return;
    const wanted = new Map(views.map((v) => [pluginPaneId(v.pluginId, v.id), v]));
    for (const panel of [...api.panels]) {
      if (panel.id.startsWith('plugin:') && !wanted.has(panel.id)) api.removePanel(panel);
    }
    const orderOf = (id: string): number => {
      const savedIndex = saved.order.indexOf(id);
      if (savedIndex >= 0) return savedIndex - 10_000;
      return CORE_SECTIONS.find((s) => s.id === id)?.order ?? wanted.get(id)?.order ?? 1000;
    };
    for (const [id, view] of wanted) {
      if (api.getPanel(id) || saved.hidden.includes(id)) continue;
      const rank = orderOf(id);
      const index = api.panels.filter((p) => orderOf(p.id) <= rank).length;
      api.addPanel<PluginPaneParams>({
        id,
        component: 'plugin-view',
        headerComponent: 'section',
        title: view.title.toUpperCase(),
        params: { pluginId: view.pluginId, viewId: view.id },
        isExpanded: !saved.collapsed.includes(id),
        size: saved.sizes[id] ?? view.initialHeight ?? 180,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: view.minHeight ?? 80,
        index,
      });
    }
  }, [api, views, saved]);
}

/**
 * Keeps the tool sections (moved here from the right sidebar or the workspace) in sync with `primaryTools`: at the
 * position they were dropped at, else where they were at the last start, else at the bottom.
 */
function useToolPanes(api: PaneviewApi | null): void {
  const tools = useUiStore((s) => s.state.primaryTools);
  useEffect(() => {
    if (!api) return;
    const wanted = new Set(tools.map((t) => t.id));
    for (const pane of [...api.panels]) {
      const toolId = (pane.params as Partial<ToolPaneParams> | undefined)?.toolId;
      if (toolId && !wanted.has(pane.id)) api.removePanel(pane);
    }
    const layout = useUiStore.getState().state.paneview;
    for (const tool of tools) {
      if (api.getPanel(tool.id)) continue;
      const saved = layout.order.indexOf(tool.id);
      const index =
        takePendingLeftIndex(tool.id) ??
        (saved >= 0
          ? api.panels.filter((p) => {
              const i = layout.order.indexOf(p.id);
              return i >= 0 && i < saved;
            }).length
          : api.panels.length);
      addToolPane(api, tool, {
        index: Math.max(0, Math.min(index, api.panels.length)),
        expanded: !layout.collapsed.includes(tool.id),
        size: layout.sizes[tool.id] ?? TOOL_DEFAULT_SIZE,
        headerSize: SIDEBAR_HEADER_SIZE,
      });
    }
    applyPendingReveal();
  }, [api, tools]);
}

export function Sidebar() {
  const saved = useUiStore((s) => s.state.paneview);
  const setPaneview = useUiStore((s) => s.setPaneview);
  const savedRef = useRef(saved);
  const [api, setApi] = useState<PaneviewApi | null>(null);
  // Layout restored at start-up (later changes are written by the paneview itself).
  const [initialLayout] = useState(saved);
  const containerRef = useRef<HTMLDivElement>(null);
  usePluginPanes(api, initialLayout);
  useEffect(() => {
    setSidebarPaneviewApi(api, 'left');
    return () => setSidebarPaneviewApi(null, 'left');
  }, [api]);
  useToolPanes(api);
  // Section headers are HTML5 drag sources: keep plugin iframes from swallowing the drag.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDragStart = () => shieldIframesWhileDragging();
    el.addEventListener('dragstart', onDragStart, true);
    return () => el.removeEventListener('dragstart', onDragStart, true);
  }, []);

  const onReady = (event: PaneviewReadyEvent) => {
    const state = savedRef.current;
    const known = new Map(CORE_SECTIONS.map((s) => [s.id, s]));
    const order = [
      ...state.order.filter((id) => known.has(id)),
      ...CORE_SECTIONS.map((s) => s.id).filter((id) => !state.order.includes(id)),
    ];
    for (const id of order) {
      const section = known.get(id);
      if (!section || state.hidden.includes(id)) continue;
      event.api.addPanel({
        id,
        component: id,
        headerComponent: 'section',
        title: section.title,
        isExpanded: state.order.includes(id) ? !state.collapsed.includes(id) : !section.collapsedByDefault,
        size: state.sizes[id] ?? section.size,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: 80,
      });
    }
    registerCommand({
      id: 'workbench.focusChanges',
      title: 'View: Focus Changes',
      run: () => {
        event.api.getPanel('changes')?.api.setExpanded(true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="changes-tree"]')?.focus());
      },
    });
    registerCommand({
      id: 'workbench.focusFiles',
      title: 'View: Focus Files',
      run: () => {
        event.api.getPanel('files')?.api.setExpanded(true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="files-tree"]')?.focus());
      },
    });
    // Tools dragged from the right sidebar (section headers) or the workspace (tabs) can be dropped here.
    event.api.onUnhandledDragOver((e) => {
      if (draggedWorkspacePanel() || toolDraggedFrom('right', getPaneData()?.paneId)) e.accept();
    });
    setApi(event.api);
    let timer: ReturnType<typeof setTimeout> | undefined;
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPaneview(readPaneviewState(event.api)), 200);
    });
  };

  const onDidDrop = (e: PaneviewDidDropEvent) => {
    const target = e.api.panels.indexOf(e.panel);
    const index = target < 0 ? undefined : target + (e.position === 'bottom' ? 1 : 0);
    const fromRight = toolDraggedFrom('right', getPaneData()?.paneId);
    if (fromRight) {
      moveSidebarToolToSide(fromRight, 'left', index);
      return;
    }
    const dragged = draggedWorkspacePanel();
    if (dragged) moveWorkspacePanelToSidebar(dragged.api, dragged.panel.id, index, 'left');
  };

  return (
    <div ref={containerRef} className="h-full" data-sidebar-side="left">
      <PaneviewReact
        className="oxy-sidebar dockview-theme-oxytocin h-full"
        components={components}
        headerComponents={{ section: PaneHeader }}
        onReady={onReady}
        onDidDrop={onDidDrop}
      />
    </div>
  );
}
