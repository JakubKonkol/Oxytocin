import { useEffect } from 'react';
import { useUiStore } from '../stores/ui-store';
import { DefaultTerminalArea } from '../features/terminals/DefaultTerminalArea';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';

export function AppLayout() {
  const sidebar = useUiStore((s) => s.state.sidebar);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  useEffect(() => {
    // Temporary until the KeybindingService (M1-T4): Ctrl/⌘+Shift+B toggles the sidebar.
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyB') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

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
