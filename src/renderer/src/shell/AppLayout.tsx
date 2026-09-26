import { useEffect } from 'react';
import { registerCommand } from '../lib/commands';
import { useUiStore } from '../stores/ui-store';
import { DefaultTerminalArea } from '../features/terminals/DefaultTerminalArea';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';

export function AppLayout() {
  const sidebar = useUiStore((s) => s.state.sidebar);

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
      <TitleBar title="Oxytocin" />
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
          <DefaultTerminalArea />
        </main>
      </div>
      <StatusBar left={<span>No project</span>} />
    </div>
  );
}
