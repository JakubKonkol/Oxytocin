import { DiffPanelComponent } from '../diff/DiffPanel';
import { PluginPanelComponent } from '../plugins/plugin-panels';
import {
  type DockviewApi,
  type DockviewDidDropEvent,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  getPaneData,
  type GetTabContextMenuItemsParams,
} from 'dockview-react';
import { useEffect, useRef } from 'react';
import { terminalRegistry } from '../terminals/terminal-registry';
import { EmptyWorkspace } from './EmptyWorkspace';
import { MissingPanel } from './MissingPanel';
import { PluginsPanel } from '../plugins/PluginsPanel';
import { KeybindingsPanel } from '../keybindings/KeybindingsPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ScratchpadPanel } from '../scratchpad/ScratchpadSection';
import {
  dropPosition,
  isMovableComponent,
  isSidebarToolDrag,
  moveSidebarToolToWorkspace,
  moveWorkspacePanelToSidebar,
} from '../tools/tools';
import { openDefaultLayout, restoreWorkspace, trackWorkspacePersistence } from './persistence';
import { shieldIframesWhileDragging } from './drag-shield';
import { GroupActions } from './GroupActions';
import { OxyTab } from './OxyTab';
import { useRenameStore } from './rename-store';
import { dockPanel, moveToFloating, splitActive } from './layout-commands';
import type { TerminalPanelParams } from './panel-registry';
import { TerminalPanelComponent } from './TerminalPanelComponent';
import { requestClosePanel, restartTerminalPanel } from './workspace-actions';
import { setActiveWorkspace, setWorkspaceApi } from './workspace-registry';
import { WorkspaceVisibleContext } from './workspace-visibility';
import { markProjectSwitchEnd } from '../../lib/perf';
import { isDialogOpen } from '../../lib/focus';
import { withErrorBoundary } from '../../ui/ErrorBoundary';
import type { EffectiveTheme } from '../../lib/theme';
import { useEffectiveTheme } from '../../lib/use-theme';
import { useTitleStore } from '../../stores/title-store';

function publishActivePanelTitle(api: DockviewApi | null): void {
  const panel = api?.activePanel;
  const terminalId =
    panel?.api.component === 'terminal' ? (panel.params as TerminalPanelParams | undefined)?.terminalId : undefined;
  useTitleStore
    .getState()
    .setActivePanel(panel ? { title: panel.title ?? '', ...(terminalId ? { terminalId } : {}) } : null);
}

const DOCKVIEW_THEMES: Record<EffectiveTheme, DockviewTheme> = {
  dark: { name: 'oxytocin', className: 'dockview-theme-oxytocin', gap: 8, colorScheme: 'dark' },
  light: { name: 'oxytocin', className: 'dockview-theme-oxytocin', gap: 8, colorScheme: 'light' },
};

// Each panel type renders inside an error boundary: a failing panel must not unmount the window.
const components = {
  terminal: withErrorBoundary(TerminalPanelComponent, 'The terminal panel'),
  diff: withErrorBoundary(DiffPanelComponent, 'The diff panel'),
  plugin: withErrorBoundary(PluginPanelComponent, 'The plugin panel'),
  scratchpad: withErrorBoundary(ScratchpadPanel, 'The scratchpad'),
  missing: MissingPanel,
  plugins: withErrorBoundary(PluginsPanel, 'The Plugins panel'),
  keybindings: withErrorBoundary(KeybindingsPanel, 'Keyboard Shortcuts'),
  settings: withErrorBoundary(SettingsPanel, 'Settings'),
};

const initializing = new Set<string>();

/** Marks drags so plugin iframes stop swallowing pointer events. */
function trackDragging(api: DockviewApi, container: HTMLElement | null): void {
  const start = () => shieldIframesWhileDragging();
  api.onWillDragPanel(start);
  api.onWillDragGroup(start);
  // Moving/resizing a floating group and dragging a sash use pointer events, not HTML5 drag events.
  container?.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const floatingChrome = target.closest('.dv-resize-container') && !target.closest('.dv-content-container');
      if (floatingChrome || target.closest('.dv-sash')) start();
    },
    true,
  );
}

function tabContextMenu(projectId: string) {
  return ({ panel, group, api }: GetTabContextMenuItemsParams) => {
    const isTerminal = panel.api.component === 'terminal';
    const others = group.panels.filter((p) => p.id !== panel.id);
    const closeMany = async (ids: string[]) => {
      for (const id of ids) if (!(await requestClosePanel(api, id))) return;
    };
    const floating = panel.api.location.type === 'floating';
    return [
      { label: 'Close', action: () => void requestClosePanel(api, panel.id) },
      { label: 'Close others', disabled: others.length === 0, action: () => void closeMany(others.map((p) => p.id)) },
      { label: 'Close all in group', action: () => void closeMany(group.panels.map((p) => p.id)) },
      ...(isTerminal
        ? [
            {
              label: 'Split right',
              action: () => {
                panel.api.setActive();
                void splitActive(api, projectId, 'right');
              },
            },
            {
              label: 'Split down',
              action: () => {
                panel.api.setActive();
                void splitActive(api, projectId, 'below');
              },
            },
            { label: 'Rename', action: () => useRenameStore.getState().start(panel.id) },
            { label: 'Restart', action: () => void restartTerminalPanel(api, panel.id) },
          ]
        : []),
      floating
        ? { label: 'Dock to layout', action: () => dockPanel(api, panel.id) }
        : { label: 'Move to new floating group', action: () => moveToFloating(api, panel.id) },
      ...(isMovableComponent(panel.api.component)
        ? [
            { label: 'Move to right sidebar', action: () => void moveWorkspacePanelToSidebar(api, panel.id) },
            {
              label: 'Move to left sidebar',
              action: () => void moveWorkspacePanelToSidebar(api, panel.id, undefined, 'left'),
            },
          ]
        : []),
    ];
  };
}

/** Restores the saved layout, or opens the default one (existing terminals or a new terminal). */
async function initializeWorkspace(projectId: string, api: DockviewApi): Promise<() => void> {
  if (initializing.has(projectId) || api.panels.length > 0) return () => undefined;
  initializing.add(projectId);
  try {
    const restored = await restoreWorkspace(api, projectId).catch(() => false);
    if (!restored) await openDefaultLayout(api, projectId);
  } finally {
    initializing.delete(projectId);
  }
  return trackWorkspacePersistence(api, projectId);
}

/** The dockview center area of one project. */
export function ProjectWorkspace({ projectId, active }: { projectId: string; active: boolean }) {
  const theme = useEffectiveTheme();
  const apiRef = useRef<DockviewApi | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    setActiveWorkspace(projectId);
    // Shown again (keep-alive): re-layout, focus the last active panel, record the switch time.
    const frame = requestAnimationFrame(() => {
      const api = apiRef.current;
      const el = containerRef.current;
      if (api && el && el.clientWidth > 0) api.layout(el.clientWidth, el.clientHeight, true);
      publishActivePanelTitle(api);
      const panel = api?.activePanel;
      if (panel?.api.component === 'terminal') {
        const id = (panel.params as TerminalPanelParams | undefined)?.terminalId;
        if (id && !isDialogOpen()) terminalRegistry.get(id)?.focus();
      }
      markProjectSwitchEnd();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, projectId]);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const stopPersistence = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopPersistence.current?.();
      if (apiRef.current) setWorkspaceApi(projectId, null);
    },
    [projectId],
  );

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    setWorkspaceApi(projectId, api);
    api.onDidActivePanelChange(({ panel }) => {
      if (activeRef.current) publishActivePanelTitle(api);
      if (panel?.api.component === 'terminal') {
        const id = (panel.params as TerminalPanelParams | undefined)?.terminalId;
        if (id) requestAnimationFrame(() => !isDialogOpen() && terminalRegistry.get(id)?.focus());
      }
    });
    trackDragging(api, containerRef.current);
    // Tools dragged out of the right sidebar (section headers) can be dropped into the layout.
    api.onUnhandledDragOver((e) => {
      if (isSidebarToolDrag(getPaneData())) e.accept();
    });
    void initializeWorkspace(projectId, api).then((stop) => {
      if (apiRef.current === api) stopPersistence.current = stop;
      else stop();
    });
  };

  return (
    <div data-testid={`workspace-${projectId}`} className="h-full" ref={containerRef}>
      <WorkspaceVisibleContext.Provider value={active}>
        <DockviewReact
          className="oxy-dockview"
          theme={DOCKVIEW_THEMES[theme]}
          components={components}
          defaultTabComponent={OxyTab}
          watermarkComponent={EmptyWorkspace}
          rightHeaderActionsComponent={GroupActions}
          getTabContextMenuItems={tabContextMenu(projectId)}
          onDidDrop={(e: DockviewDidDropEvent) => {
            const data = getPaneData();
            if (!isSidebarToolDrag(data)) return;
            moveSidebarToolToWorkspace(data.paneId, {
              api: e.api,
              projectId,
              position: dropPosition(e.position, e.group),
            });
          }}
          singleTabMode="fullwidth"
          defaultRenderer="always"
          onReady={onReady}
        />
      </WorkspaceVisibleContext.Provider>
    </div>
  );
}
