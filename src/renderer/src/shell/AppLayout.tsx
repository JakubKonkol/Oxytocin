import { useEffect } from 'react';
import { registerCommand } from '../lib/commands';
import { useUiStore } from '../stores/ui-store';
import { activeProject, useProjectsStore } from '../stores/projects-store';
import { useTerminalsStore } from '../stores/terminals-store';
import { useTitleStore } from '../stores/title-store';
import { WorkspaceArea } from '../features/projects/WorkspaceArea';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { StatusBar } from './StatusBar';
import { useAttentionBadge, useWaitingCount } from '../features/attention/attention-badge';
import { ActivityStatusItems, NotificationsToggle } from '../features/attention/StatusItems';
import { PluginStatusItems } from '../features/plugins/PluginStatusItems';
import { PluginsStatusButton } from '../features/plugins/plugin-manager';
import { TitleBar } from './TitleBar';
import { HelpDialogs } from '../features/help/HelpDialogs';

/** "<project> — <active panel> — Oxytocin" (docs/plan/05-layout-center.md §8). */
function useWindowTitle(): string {
  const project = useProjectsStore(activeProject);
  const panel = useTitleStore((s) => s.panel);
  const terminalTitle = useTerminalsStore((s) =>
    panel?.terminalId ? s.terminals[panel.terminalId]?.title : undefined,
  );
  const panelTitle = terminalTitle ?? panel?.title;
  const waiting = useWaitingCount();
  useAttentionBadge(waiting);
  const parts = [project?.name, project ? panelTitle : undefined, 'Oxytocin'].filter(Boolean);
  const title = `${waiting > 0 ? `(${waiting}) ` : ''}${parts.join(' — ')}`;
  useEffect(() => {
    document.title = title;
  }, [title]);
  return project ? [project.name, panelTitle].filter(Boolean).join(' — ') : 'Oxytocin';
}

export function AppLayout() {
  const sidebar = useUiStore((s) => s.state.sidebar);
  const title = useWindowTitle();

  useEffect(
    () =>
      registerCommand({
        id: 'workbench.toggleSidebar',
        title: 'View: Toggle Sidebar',
        run: () => useUiStore.getState().toggleSidebar(),
      }),
    [],
  );

  return (
    <div className="flex h-full flex-col bg-app">
      <TitleBar title={title} />
      <HelpDialogs />
      <div className="flex min-h-0 flex-1 px-2">
        {!sidebar.collapsed && (
          <>
            <aside data-testid="sidebar" className="h-full flex-none" style={{ width: sidebar.width }}>
              <Sidebar />
            </aside>
            <SidebarResizer />
          </>
        )}
        <main data-testid="center" className="min-w-0 flex-1 pb-0">
          <WorkspaceArea />
        </main>
      </div>
      <StatusBar
        left={
          <>
            <ActivityStatusItems />
            <PluginStatusItems alignment="left" />
          </>
        }
        right={
          <>
            <PluginStatusItems alignment="right" />
            <PluginsStatusButton />
            <NotificationsToggle />
          </>
        }
      />
    </div>
  );
}
