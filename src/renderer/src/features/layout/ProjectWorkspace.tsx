import { type DockviewApi, DockviewReact, type DockviewReadyEvent, type DockviewTheme } from 'dockview-react';
import { useEffect, useRef } from 'react';
import { useTerminalsStore } from '../../stores/terminals-store';
import { terminalRegistry } from '../terminals/terminal-registry';
import { EmptyWorkspace } from './EmptyWorkspace';
import { OxyTab } from './OxyTab';
import type { TerminalPanelParams } from './panel-registry';
import { TerminalPanelComponent } from './TerminalPanelComponent';
import { addExistingTerminalPanel, addTerminalPanel } from './workspace-actions';
import { setActiveWorkspace, setWorkspaceApi } from './workspace-registry';

const oxyTheme: DockviewTheme = { name: 'oxytocin', className: 'dockview-theme-oxytocin', gap: 8, colorScheme: 'dark' };

const components = { terminal: TerminalPanelComponent };

const initializing = new Set<string>();

/** Opens the initial panels of an empty workspace: existing terminals (renderer reload) or a new one. */
async function initializeWorkspace(projectId: string, api: DockviewApi): Promise<void> {
  if (initializing.has(projectId) || api.panels.length > 0) return;
  initializing.add(projectId);
  try {
    const existing = Object.values(useTerminalsStore.getState().terminals).filter((t) => t.projectId === projectId);
    if (existing.length > 0) {
      for (const t of existing) addExistingTerminalPanel(api, t.id, t.title);
    } else {
      await addTerminalPanel(api, { projectId });
    }
  } finally {
    initializing.delete(projectId);
  }
}

/** The dockview center area of one project. */
export function ProjectWorkspace({ projectId, active }: { projectId: string; active: boolean }) {
  const apiRef = useRef<DockviewApi | null>(null);

  useEffect(() => {
    if (active) setActiveWorkspace(projectId);
  }, [active, projectId]);

  useEffect(
    () => () => {
      if (apiRef.current) setWorkspaceApi(projectId, null);
    },
    [projectId],
  );

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    setWorkspaceApi(projectId, api);
    api.onDidActivePanelChange(({ panel }) => {
      if (panel?.api.component === 'terminal') {
        const id = (panel.params as TerminalPanelParams | undefined)?.terminalId;
        if (id) requestAnimationFrame(() => terminalRegistry.get(id)?.focus());
      }
    });
    void initializeWorkspace(projectId, api);
  };

  return (
    <div data-testid={`workspace-${projectId}`} className="h-full">
      <DockviewReact
        className="oxy-dockview"
        theme={oxyTheme}
        components={components}
        defaultTabComponent={OxyTab}
        watermarkComponent={EmptyWorkspace}
        singleTabMode="fullwidth"
        defaultRenderer="always"
        disableFloatingGroups
        onReady={onReady}
      />
    </div>
  );
}
