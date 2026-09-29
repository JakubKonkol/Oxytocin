import type { IPaneviewPanelProps, PaneviewApi } from 'dockview-react';
import { ArrowLeftToLine, ArrowRightToLine, PanelLeft, PanelRight, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SidebarTool } from '@shared/domain/ui-state';
import { SectionBody } from '../ui/Section';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { useUiStore } from '../stores/ui-store';
import { usePluginsStore } from '../stores/plugins-store';
import { ScratchpadHeaderActions, ScratchpadSection } from '../features/scratchpad/ScratchpadSection';
import { PluginFrame } from '../features/plugins/PluginFrame';
import { viewStates } from '../features/plugins/view-bridge';
import { SidebarAddToolMenu } from '../features/tools/AddMenus';
import {
  closeSidebarTool,
  findSidebarTool,
  moveSidebarToolToSide,
  moveSidebarToolToWorkspace,
  type SidebarSide,
} from '../features/tools/tools';

/** Sections of tools (scratchpad, plugin panels) in either sidebar. */
export interface ToolPaneParams {
  toolId: string;
}

export function toolTitle(tool: SidebarTool): string {
  if (tool.kind === 'scratchpad') return 'SCRATCHPAD';
  const contribution = usePluginsStore
    .getState()
    .contributions.panels.find((p) => p.pluginId === tool.pluginId && p.type === tool.panelType);
  return (tool.title ?? contribution?.title ?? tool.panelType).toUpperCase();
}

const findTool = (tools: SidebarTool[], id: string) => tools.find((t) => t.id === id);

/** A plugin panel living in a sidebar; mounted on first expansion, its state kept in ui-state.json. */
function PluginToolPane(props: IPaneviewPanelProps<ToolPaneParams>) {
  const tool = useUiStore(
    (s) => findTool(s.state.secondaryTools, props.params.toolId) ?? findTool(s.state.primaryTools, props.params.toolId),
  );
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

export const TOOL_COMPONENTS = {
  scratchpad: () => <ScratchpadSection />,
  'plugin-tool': PluginToolPane,
};

/** Section header actions of a tool: add below (right sidebar), move to the other sidebar or the workspace, close. */
export function ToolActions({ toolId, side }: { toolId: string; side: SidebarSide }) {
  const index = useUiStore((s) => s.state.secondaryTools.findIndex((t) => t.id === toolId));
  const other: SidebarSide = side === 'right' ? 'left' : 'right';
  return (
    <>
      {toolId === 'scratchpad' && <ScratchpadHeaderActions />}
      {side === 'right' && (
        <SidebarAddToolMenu
          index={index + 1}
          trigger={<IconButton data-testid={`add-tool-below-${toolId}`} label="Add tool" icon={<Plus size={13} />} />}
        />
      )}
      <IconButton
        data-testid={`move-tool-side-${toolId}`}
        label={`Move to ${other} sidebar`}
        icon={other === 'left' ? <PanelLeft size={13} /> : <PanelRight size={13} />}
        onClick={() => void moveSidebarToolToSide(toolId, other)}
      />
      <IconButton
        data-testid={`move-tool-${toolId}`}
        label="Move to workspace"
        icon={side === 'right' ? <ArrowLeftToLine size={13} /> : <ArrowRightToLine size={13} />}
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

/** Adds a tool's section to a paneview. */
export function addToolPane(
  api: PaneviewApi,
  tool: SidebarTool,
  o: { index: number; expanded: boolean; size: number; headerSize: number },
): void {
  api.addPanel<ToolPaneParams>({
    id: tool.id,
    component: tool.kind === 'scratchpad' ? 'scratchpad' : 'plugin-tool',
    headerComponent: 'section',
    title: toolTitle(tool),
    params: { toolId: tool.id },
    isExpanded: o.expanded,
    size: o.size,
    headerSize: o.headerSize,
    minimumBodySize: 120,
    index: o.index,
  });
}

/** The tool a paneview drag carries when it comes from the other sidebar. */
export function toolDraggedFrom(side: SidebarSide, paneId: string | undefined): string | undefined {
  if (!paneId) return undefined;
  return findSidebarTool(paneId)?.side === side ? paneId : undefined;
}
