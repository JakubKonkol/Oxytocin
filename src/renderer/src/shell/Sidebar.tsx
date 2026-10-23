import {
  getPaneData,
  type IPaneviewPanelProps,
  type PaneviewApi,
  type PaneviewDidDropEvent,
  PaneviewReact,
  type PaneviewReadyEvent,
} from 'dockview-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { PaneviewState } from '@shared/domain/ui-state';
import { FolderPlus, Plus, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { SectionHeader } from '../ui/Section';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { ProjectsSection } from '../features/projects/ProjectsSection';
import { ChangesCount, ChangesHeaderActions, ChangesSection } from '../features/changes/ChangesSection';
import { FilesHeaderActions, FilesSection } from '../features/editor/FilesSection';
import { addProjectViaDialog } from '../features/projects/project-actions';
import { useProjectsStore } from '../stores/projects-store';
import { onUiFlush, useUiStore } from '../stores/ui-store';
import { usePluginsStore } from '../stores/plugins-store';
import { type PluginPaneParams, PluginSidebarView, sidebarViewInstanceId } from '../features/plugins/PluginSidebarView';
import { LeftSidebarAddMenu } from '../features/tools/AddMenus';
import {
  closeSidebarSection,
  CORE_SECTIONS,
  defaultSectionIndex,
  pluginSectionId,
  sidebarSections,
  takePendingSectionIndex,
  useSidebarSections,
} from '../features/tools/sidebar-sections';
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

function ProjectsHeaderActions() {
  return (
    <IconButton
      data-testid="projects-add"
      label="Add project"
      shortcut="Ctrl+Shift+A"
      icon={<FolderPlus size={13} />}
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

/** "+" (add a closed section or a tool below) and "×" (close) of a section header. */
function SectionActions({ id }: { id: string }) {
  return (
    <>
      <LeftSidebarAddMenu
        belowId={id}
        trigger={<IconButton data-testid={`add-below-${id}`} label="Add section or tool" icon={<Plus size={13} />} />}
      />
      <IconButton
        data-testid={`close-section-${id}`}
        label="Close section"
        icon={<X size={13} />}
        onClick={() => closeSidebarSection(id)}
      />
    </>
  );
}

function PaneHeader(props: IPaneviewPanelProps) {
  const [expanded, setExpanded] = useState(props.api.isExpanded);
  useEffect(() => {
    const d = props.api.onDidExpansionChange((e) => setExpanded(e.isExpanded));
    return () => d.dispose();
  }, [props.api]);
  const plugin = props.params as Partial<PluginPaneParams & ToolPaneParams> | undefined;
  const id = props.api.id;
  const section = (own?: ReactNode) => (
    <>
      {own}
      <SectionActions id={id} />
    </>
  );
  const extras = plugin?.toolId
    ? { actions: <ToolActions toolId={plugin.toolId} side="left" /> }
    : plugin?.pluginId && plugin.viewId
      ? {
          actions: section(),
          count: <PluginPaneBadge instanceId={sidebarViewInstanceId(plugin.pluginId, plugin.viewId)} />,
        }
      : id === 'projects'
        ? { actions: section(<ProjectsHeaderActions />), count: <ProjectsCount /> }
        : id === 'changes'
          ? { actions: section(<ChangesHeaderActions />), count: <ChangesCount /> }
          : id === 'files'
            ? { actions: section(<FilesHeaderActions />) }
            : { actions: section() };
  return (
    <SectionHeader
      testId={`section-header-${id}`}
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
  const previous = useUiStore.getState().state.paneview;
  // Closed sections keep their size for when they come back.
  const closedSizes = previous.hidden.flatMap((id) =>
    previous.sizes[id] !== undefined ? [[id, previous.sizes[id]] as const] : [],
  );
  return {
    order: panels.map((p) => p.id),
    sizes: Object.fromEntries([
      ...closedSizes,
      ...panels.filter((p) => p.api.isExpanded).map((p) => [p.id, Math.round(p.height)] as const),
    ]),
    collapsed: panels.filter((p) => !p.api.isExpanded).map((p) => p.id),
    hidden: previous.hidden,
  };
}

/** Adds the core sections re-opened from a "+" menu and removes the ones closed. */
function useCoreSections(api: PaneviewApi | null): void {
  const hidden = useUiStore((s) => s.state.paneview.hidden);
  useEffect(() => {
    if (!api) return;
    const layout = useUiStore.getState().state.paneview;
    const sections = sidebarSections(usePluginsStore.getState().contributions.views);
    for (const section of CORE_SECTIONS) {
      const panel = api.getPanel(section.id);
      if (hidden.includes(section.id)) {
        if (panel) api.removePanel(panel);
        continue;
      }
      if (panel) continue;
      const index =
        takePendingSectionIndex(section.id) ??
        defaultSectionIndex(
          section.id,
          api.panels.map((p) => p.id),
          sections,
        );
      api.addPanel({
        id: section.id,
        component: section.id,
        headerComponent: 'section',
        title: section.title.toUpperCase(),
        isExpanded: true,
        size: layout.sizes[section.id] ?? section.size,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: 80,
        index: Math.max(0, Math.min(index, api.panels.length)),
      });
    }
    applyPendingReveal();
  }, [api, hidden]);
}

/** Adds/removes plugin view panes when contributions change; saved order first, then `order`. */
function usePluginPanes(api: PaneviewApi | null, saved: PaneviewState): void {
  const views = usePluginsStore((s) => s.contributions.views);
  const hidden = useUiStore((s) => s.state.paneview.hidden);
  useEffect(() => {
    if (!api) return;
    const wanted = new Map(
      views.map((v) => [pluginSectionId(v.pluginId, v.id), v] as const).filter(([id]) => !hidden.includes(id)),
    );
    for (const panel of [...api.panels]) {
      if (panel.id.startsWith('plugin:') && !wanted.has(panel.id)) api.removePanel(panel);
    }
    const orderOf = (id: string): number => {
      const savedIndex = saved.order.indexOf(id);
      if (savedIndex >= 0) return savedIndex - 10_000;
      return CORE_SECTIONS.find((s) => s.id === id)?.order ?? wanted.get(id)?.order ?? 1000;
    };
    for (const [id, view] of wanted) {
      if (api.getPanel(id)) continue;
      const rank = orderOf(id);
      const index = takePendingSectionIndex(id) ?? api.panels.filter((p) => orderOf(p.id) <= rank).length;
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
        index: Math.max(0, Math.min(index, api.panels.length)),
      });
    }
    applyPendingReveal();
  }, [api, views, saved, hidden]);
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
  const pendingLayout = useRef<() => void>(undefined);
  useEffect(() => onUiFlush(() => pendingLayout.current?.()), []);
  const [api, setApi] = useState<PaneviewApi | null>(null);
  // Layout restored at start-up (later changes are written by the paneview itself).
  const [initialLayout] = useState(saved);
  const containerRef = useRef<HTMLDivElement>(null);
  usePluginPanes(api, initialLayout);
  useCoreSections(api);
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
        title: section.title.toUpperCase(),
        isExpanded: state.order.includes(id) ? !state.collapsed.includes(id) : !section.collapsedByDefault,
        size: state.sizes[id] ?? section.size,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: 80,
      });
    }
    // Tools dragged from the right sidebar (section headers) or the workspace (tabs) can be dropped here.
    event.api.onUnhandledDragOver((e) => {
      if (draggedWorkspacePanel() || toolDraggedFrom('right', getPaneData()?.paneId)) e.accept();
    });
    setApi(event.api);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
      timer = undefined;
      setPaneview(readPaneviewState(event.api));
    };
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, 200);
    });
    // Quitting right after a change keeps it.
    pendingLayout.current = () => {
      if (!timer) return;
      clearTimeout(timer);
      write();
    };
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
    <div ref={containerRef} className="relative h-full" data-sidebar-side="left">
      <PaneviewReact
        className="oxy-sidebar dockview-theme-oxytocin h-full"
        components={components}
        headerComponents={{ section: PaneHeader }}
        onReady={onReady}
        onDidDrop={onDidDrop}
      />
      <EmptySidebar />
    </div>
  );
}

/** Shown when every section and tool of the left sidebar is closed: add one back, or drop a tool here. */
function EmptySidebar() {
  const sections = useSidebarSections();
  const hidden = useUiStore((s) => s.state.paneview.hidden);
  const tools = useUiStore((s) => s.state.primaryTools.length);
  const [over, setOver] = useState(false);
  if (tools > 0 || sections.some((s) => !hidden.includes(s.id))) return null;
  const dragged = () => draggedWorkspacePanel() ?? toolDraggedFrom('right', getPaneData()?.paneId);
  return (
    <div
      data-testid="sidebar-empty"
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-card border border-dashed p-4 text-center',
        over ? 'border-accent bg-accent-muted' : 'border-line-subtle bg-card',
      )}
      onDragOver={(e) => {
        if (!dragged()) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const fromRight = toolDraggedFrom('right', getPaneData()?.paneId);
        const panel = draggedWorkspacePanel();
        if (!fromRight && !panel) return;
        e.preventDefault();
        if (fromRight) moveSidebarToolToSide(fromRight, 'left', 0);
        else if (panel) moveWorkspacePanelToSidebar(panel.api, panel.panel.id, 0, 'left');
      }}
    >
      <div className="text-ui text-fg-secondary">All sections are closed</div>
      <div className="text-small text-fg-muted">Add Projects, Changes, Files or a tool back, or drag a tool here.</div>
      <LeftSidebarAddMenu
        trigger={
          <Button data-testid="sidebar-add-section" size="sm">
            <Plus size={12} /> Add section
          </Button>
        }
      />
    </div>
  );
}
