import {
  getPaneData,
  type IPaneviewPanelProps,
  type PaneviewApi,
  type PaneviewDidDropEvent,
  PaneviewReact,
  type PaneviewReadyEvent,
} from 'dockview-react';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PaneviewState, SidebarTool } from '@shared/domain/ui-state';
import { cn } from '../lib/cn';
import { SectionHeader } from '../ui/Section';
import { Button } from '../ui/Button';
import { useUiStore } from '../stores/ui-store';
import { shieldIframesWhileDragging } from '../features/layout/drag-shield';
import { SidebarAddToolMenu } from '../features/tools/AddMenus';
import {
  applyPendingReveal,
  draggedWorkspacePanel,
  moveSidebarToolToSide,
  moveWorkspacePanelToSidebar,
  setSidebarPaneviewApi,
} from '../features/tools/tools';
import { SIDEBAR_HEADER_SIZE } from './Sidebar';
import { addToolPane, TOOL_COMPONENTS, ToolActions, type ToolPaneParams, toolDraggedFrom } from './sidebar-tools';

const DEFAULT_SIZE = 400;

const toolOf = (id: string) => useUiStore.getState().state.secondaryTools.find((t) => t.id === id);

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
      actions={<ToolActions toolId={props.api.id} side="right" />}
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
      addToolPane(api, tool, {
        index,
        expanded: !layout.collapsed.includes(tool.id),
        size: layout.sizes[tool.id] ?? DEFAULT_SIZE,
        headerSize: SIDEBAR_HEADER_SIZE,
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
        if (!draggedWorkspacePanel() && !toolDraggedFrom('left', getPaneData()?.paneId)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!draggedWorkspacePanel() && !toolDraggedFrom('left', getPaneData()?.paneId)) return;
        e.preventDefault();
        onDropPanel();
      }}
    >
      <div className="text-ui text-fg-secondary">No tools open</div>
      <div className="text-small text-fg-muted">Add one, or drag a tool tab or a left sidebar tool here.</div>
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
    setSidebarPaneviewApi(api, 'right');
    return () => setSidebarPaneviewApi(null, 'right');
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
    // Tools of the left sidebar (section headers) too.
    event.api.onUnhandledDragOver((e) => {
      if (draggedWorkspacePanel() || toolDraggedFrom('left', getPaneData()?.paneId)) e.accept();
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
    const target = e.api.panels.indexOf(e.panel);
    const index = target < 0 ? undefined : target + (e.position === 'bottom' ? 1 : 0);
    const fromLeft = toolDraggedFrom('left', getPaneData()?.paneId);
    if (fromLeft) {
      moveSidebarToolToSide(fromLeft, 'right', index);
      return;
    }
    const dragged = draggedWorkspacePanel();
    if (dragged) moveWorkspacePanelToSidebar(dragged.api, dragged.panel.id, index);
  };

  return (
    <div ref={containerRef} className="relative h-full" data-testid="secondary-sidebar-tools" data-sidebar-side="right">
      <PaneviewReact
        className="oxy-sidebar dockview-theme-oxytocin h-full"
        components={TOOL_COMPONENTS}
        headerComponents={{ section: PaneHeader }}
        onReady={onReady}
        onDidDrop={onDidDrop}
      />
      {empty && (
        <EmptyTools
          onDropPanel={() => {
            const fromLeft = toolDraggedFrom('left', getPaneData()?.paneId);
            if (fromLeft) {
              moveSidebarToolToSide(fromLeft, 'right', 0);
              return;
            }
            const dragged = draggedWorkspacePanel();
            if (dragged) moveWorkspacePanelToSidebar(dragged.api, dragged.panel.id, 0);
          }}
        />
      )}
    </div>
  );
}
