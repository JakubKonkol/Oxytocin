import {
  type IPaneviewPanelProps,
  type PaneviewApi,
  type PaneviewDidDropEvent,
  PaneviewReact,
  type PaneviewReadyEvent,
} from 'dockview-react';
import { ArrowLeftToLine, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PaneviewState, SidebarTool } from '@shared/domain/ui-state';
import { cn } from '../lib/cn';
import { SectionBody, SectionHeader } from '../ui/Section';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { useUiStore } from '../stores/ui-store';
import { usePluginsStore } from '../stores/plugins-store';
import { ScratchpadHeaderActions, ScratchpadSection } from '../features/scratchpad/ScratchpadSection';
import { PluginFrame } from '../features/plugins/PluginFrame';
import { viewStates } from '../features/plugins/view-bridge';
import { shieldIframesWhileDragging } from '../features/layout/drag-shield';
import { SidebarAddToolMenu } from '../features/tools/AddMenus';
import {
  applyPendingReveal,
  closeSidebarTool,
  draggedWorkspacePanel,
  moveSidebarToolToWorkspace,
  moveWorkspacePanelToSidebar,
  setSidebarPaneviewApi,
} from '../features/tools/tools';
import { SIDEBAR_HEADER_SIZE } from './Sidebar';

const DEFAULT_SIZE = 400;

interface ToolPaneParams {
  toolId: string;
}

const toolOf = (id: string) => useUiStore.getState().state.secondaryTools.find((t) => t.id === id);

function toolTitle(tool: SidebarTool): string {
  if (tool.kind === 'scratchpad') return 'SCRATCHPAD';
  const contribution = usePluginsStore
    .getState()
    .contributions.panels.find((p) => p.pluginId === tool.pluginId && p.type === tool.panelType);
  return (tool.title ?? contribution?.title ?? tool.panelType).toUpperCase();
}

/** A plugin panel living in the right sidebar; mounted on first expansion, its state kept in ui-state.json. */
function PluginToolPane(props: IPaneviewPanelProps<ToolPaneParams>) {
  const tool = useUiStore((s) => s.state.secondaryTools.find((t) => t.id === props.params.toolId));
  const plugin = tool?.kind === 'plugin' ? tool : undefined;
  const contribution = usePluginsStore((s) =>
    plugin
      ? s.contributions.panels.find((p) => p.pluginId === plugin.pluginId && p.type === plugin.panelType)
      : undefined,
  );
  const [expanded, setExpanded] = useState(props.api.isExpanded);
  const [everExpanded, setEverExpanded] = useState(props.api.isExpanded);
  useEffect(() => {
    const d = props.api.onDidExpansionChange((e) => {
      setExpanded(e.isExpanded);
      if (e.isExpanded) setEverExpanded(true);
    });
    return () => d.dispose();
  }, [props.api]);
  // State saved at quit comes back through oxy:init.state.
  const [viewId] = useState(() => {
    if (plugin && !viewStates.has(plugin.viewId)) {
      const saved = useUiStore.getState().state.pluginViewState[plugin.viewId];
      if (saved !== undefined) viewStates.set(plugin.viewId, saved);
    }
    return plugin?.viewId;
  });
  if (!plugin || !viewId) return null;
  if (!contribution)
    return (
      <SectionBody className="flex items-center justify-center">
        <EmptyState title="This tool is unavailable" description="Enable its plugin, or close the tool." />
      </SectionBody>
    );
  return (
    <SectionBody className="flex flex-col p-0">
      <div className="min-h-0 flex-1" data-testid={`sidebar-tool-${plugin.panelType}`}>
        {everExpanded && (
          <PluginFrame
            pluginId={plugin.pluginId}
            entry={contribution.entry}
            viewId={viewId}
            kind="panel"
            providerId={plugin.panelType}
            {...(plugin.params !== undefined ? { params: plugin.params } : {})}
            title={plugin.title ?? contribution.title}
            visible={expanded}
            onStateChange={() => useUiStore.getState().setPluginViewState(viewId, viewStates.get(viewId))}
          />
        )}
      </div>
    </SectionBody>
  );
}

const components = {
  scratchpad: () => <ScratchpadSection />,
  'plugin-tool': PluginToolPane,
};

function ToolActions({ toolId }: { toolId: string }) {
  const index = useUiStore((s) => s.state.secondaryTools.findIndex((t) => t.id === toolId));
  return (
    <>
      {toolId === 'scratchpad' && <ScratchpadHeaderActions />}
      <SidebarAddToolMenu
        index={index + 1}
        trigger={<IconButton data-testid={`add-tool-below-${toolId}`} label="Add tool" icon={<Plus size={13} />} />}
      />
      <IconButton
        data-testid={`move-tool-${toolId}`}
        label="Move to workspace"
        icon={<ArrowLeftToLine size={13} />}
        onClick={() => void moveSidebarToolToWorkspace(toolId)}
      />
      <IconButton
        data-testid={`close-tool-${toolId}`}
        label="Close"
        icon={<X size={13} />}
        onClick={() => closeSidebarTool(toolId)}
      />
    </>
  );
}

function PaneHeader(props: IPaneviewPanelProps<ToolPaneParams>) {
  const [expanded, setExpanded] = useState(props.api.isExpanded);
  useEffect(() => {
    const d = props.api.onDidExpansionChange((e) => setExpanded(e.isExpanded));
    return () => d.dispose();
  }, [props.api]);
  return (
    <SectionHeader
      testId={`section-header-${props.api.id}`}
      title={props.title}
      expanded={expanded}
      onToggle={() => props.api.setExpanded(!expanded)}
      actions={<ToolActions toolId={props.api.id} />}
    />
  );
}

function readPaneviewState(api: PaneviewApi): PaneviewState {
  return {
    order: api.panels.map((p) => p.id),
    sizes: Object.fromEntries(api.panels.filter((p) => p.api.isExpanded).map((p) => [p.id, Math.round(p.height)])),
    collapsed: api.panels.filter((p) => !p.api.isExpanded).map((p) => p.id),
    hidden: [],
  };
}

/** Keeps the paneview's sections in sync with the tool list (added, closed, moved away). */
function useToolPanes(api: PaneviewApi | null): void {
  const tools = useUiStore((s) => s.state.secondaryTools);
  useEffect(() => {
    if (!api) return;
    const wanted = new Set(tools.map((t) => t.id));
    for (const pane of [...api.panels]) if (!wanted.has(pane.id)) api.removePanel(pane);
    const layout = useUiStore.getState().state.secondaryPaneview;
    tools.forEach((tool, index) => {
      if (api.getPanel(tool.id)) return;
      api.addPanel<ToolPaneParams>({
        id: tool.id,
        component: tool.kind === 'scratchpad' ? 'scratchpad' : 'plugin-tool',
        headerComponent: 'section',
        title: toolTitle(tool),
        params: { toolId: tool.id },
        isExpanded: !layout.collapsed.includes(tool.id),
        size: layout.sizes[tool.id] ?? DEFAULT_SIZE,
        headerSize: SIDEBAR_HEADER_SIZE,
        minimumBodySize: 120,
        index,
      });
    });
    applyPendingReveal();
  }, [api, tools]);
}

/** Drop target when every tool is closed: tabs dragged from the workspace land here. */
function EmptyTools({ onDropPanel }: { onDropPanel: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid="secondary-sidebar-empty"
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-card border border-dashed p-4 text-center',
        over ? 'border-accent bg-accent-muted' : 'border-line-subtle bg-card',
      )}
      onDragOver={(e) => {
        if (!draggedWorkspacePanel()) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!draggedWorkspacePanel()) return;
        e.preventDefault();
        onDropPanel();
      }}
    >
      <div className="text-ui text-fg-secondary">No tools open</div>
      <div className="text-small text-fg-muted">Add one, or drag a scratchpad or plugin tab here.</div>
      <SidebarAddToolMenu
        trigger={
          <Button data-testid="sidebar-add-tool" size="sm">
            <Plus size={12} /> Add tool
          </Button>
        }
      />
    </div>
  );
}

/**
 * Right column: tools (scratchpad, plugin panels) as collapsible, resizable sections, toggled from the title bar.
 * Tools are added from the "Add tool" menu, closed, reordered, and moved to and from the workspace by drag and drop.
 */
export function SecondarySidebar() {
  const [api, setApi] = useState<PaneviewApi | null>(null);
  const empty = useUiStore((s) => s.state.secondaryTools.length === 0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Registered before the tool sections are synced, so a pending reveal finds the sections.
  useEffect(() => {
    setSidebarPaneviewApi(api);
    return () => setSidebarPaneviewApi(null);
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
    // Tabs dragged from a workspace (scratchpad, plugin panels) can be dropped between the sections.
    event.api.onUnhandledDragOver((e) => {
      if (draggedWorkspacePanel()) e.accept();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const ui = useUiStore.getState();
        ui.setSecondaryPaneview(readPaneviewState(event.api));
        // Sections reordered by drag and drop: the tool list follows.
        const order = event.api.panels.map((p) => p.id);
        const tools = ui.state.secondaryTools;
        if (order.length === tools.length && order.join('\n') !== tools.map((t) => t.id).join('\n')) {
          const next = order.map((id) => toolOf(id)).filter((t): t is SidebarTool => !!t);
          if (next.length === tools.length) ui.setSecondaryTools(next);
        }
      }, 200);
    });
    setApi(event.api);
  };

  const onDidDrop = (e: PaneviewDidDropEvent) => {
    const dragged = draggedWorkspacePanel();
    if (!dragged) return;
    const target = e.api.panels.indexOf(e.panel);
    const index = target < 0 ? undefined : target + (e.position === 'bottom' ? 1 : 0);
    moveWorkspacePanelToSidebar(dragged.api, dragged.panel.id, index);
  };

  return (
    <div ref={containerRef} className="relative h-full" data-testid="secondary-sidebar-tools">
      <PaneviewReact
        className="oxy-sidebar dockview-theme-oxytocin h-full"
        components={components}
        headerComponents={{ section: PaneHeader }}
        onReady={onReady}
        onDidDrop={onDidDrop}
      />
      {empty && (
        <EmptyTools
          onDropPanel={() => {
            const dragged = draggedWorkspacePanel();
            if (dragged) moveWorkspacePanelToSidebar(dragged.api, dragged.panel.id, 0);
          }}
        />
      )}
    </div>
  );
}
