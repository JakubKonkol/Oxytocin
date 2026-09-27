import { DiffPanelComponent } from '../diff/DiffPanel';
import { PluginPanelComponent } from '../plugins/plugin-panels';
import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type GetTabContextMenuItemsParams,
} from 'dockview-react';
import { useEffect, useRef } from 'react';
import { terminalRegistry } from '../terminals/terminal-registry';
import { EmptyWorkspace } from './EmptyWorkspace';
import { MissingPanel } from './MissingPanel';
import { PluginsPanel } from '../plugins/PluginsPanel';
import { KeybindingsPanel } from '../keybindings/KeybindingsPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { openDefaultLayout, restoreWorkspace, trackWorkspacePersistence } from './persistence';
import { GroupActions } from './GroupActions';
import { OxyTab } from './OxyTab';
import { useRenameStore } from './rename-store';
import { splitActive } from './layout-commands';
import type { TerminalPanelParams } from './panel-registry';
import { TerminalPanelComponent } from './TerminalPanelComponent';
import { requestClosePanel, restartTerminalPanel } from './workspace-actions';
import { setActiveWorkspace, setWorkspaceApi } from './workspace-registry';
import { WorkspaceVisibleContext } from './workspace-visibility';
import { markProjectSwitchEnd } from '../../lib/perf';
import { isDialogOpen } from '../../lib/focus';
import { useTitleStore } from '../../stores/title-store';

function publishActivePanelTitle(api: DockviewApi | null): void {
  const panel = api?.activePanel;
  const terminalId =
    panel?.api.component === 'terminal' ? (panel.params as TerminalPanelParams | undefined)?.terminalId : undefined;
  useTitleStore
    .getState()
    .setActivePanel(panel ? { title: panel.title ?? '', ...(terminalId ? { terminalId } : {}) } : null);
}

const oxyTheme: DockviewTheme = { name: 'oxytocin', className: 'dockview-theme-oxytocin', gap: 8, colorScheme: 'dark' };

const components = {
  terminal: TerminalPanelComponent,
  diff: DiffPanelComponent,
  plugin: PluginPanelComponent,
  missing: MissingPanel,
  plugins: PluginsPanel,
  keybindings: KeybindingsPanel,
  settings: SettingsPanel,
};

const initializing = new Set<string>();

/** Marks drags so plugin iframes stop swallowing pointer events (docs/plan/05-layout-center.md §7). */
function trackDragging(api: DockviewApi): void {
  let safety: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    document.body.classList.remove('oxy-dragging');
    if (safety) clearTimeout(safety);
  };
  const start = () => {
    document.body.classList.add('oxy-dragging');
    if (safety) clearTimeout(safety);
    safety = setTimeout(stop, 5000);
    for (const type of ['dragend', 'drop', 'mouseup', 'pointerup'] as const) {
      window.addEventListener(type, stop, { once: true, capture: true });
    }
  };
  api.onWillDragPanel(start);
  api.onWillDragGroup(start);
}

function tabContextMenu(projectId: string) {
  return ({ panel, group, api }: GetTabContextMenuItemsParams) => {
    const isTerminal = panel.api.component === 'terminal';
    const others = group.panels.filter((p) => p.id !== panel.id);
    const closeMany = async (ids: string[]) => {
      for (const id of ids) if (!(await requestClosePanel(api, id))) return;
    };
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
    trackDragging(api);
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
          theme={oxyTheme}
          components={components}
          defaultTabComponent={OxyTab}
          watermarkComponent={EmptyWorkspace}
          rightHeaderActionsComponent={GroupActions}
          getTabContextMenuItems={tabContextMenu(projectId)}
          singleTabMode="fullwidth"
          defaultRenderer="always"
          disableFloatingGroups
          onReady={onReady}
        />
      </WorkspaceVisibleContext.Provider>
    </div>
  );
}
