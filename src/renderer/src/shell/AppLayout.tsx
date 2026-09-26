import { useEffect } from 'react';
import { useUiStore } from '../stores/ui-store';
import { EmptyState } from '../ui/EmptyState';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';

function WelcomePlaceholder() {
  return (
    <div className="flex h-full items-center justify-center rounded-card border border-line-subtle bg-card">
      <EmptyState
        icon={
          <svg aria-hidden width="40" height="40" viewBox="0 0 14 14" className="text-line-focus">
            <path d="M7 0 14 7 7 14 0 7Z" fill="currentColor" />
          </svg>
        }
        title="Welcome to Oxytocin"
        description="Your projects, terminals and AI agents will live here."
      />
    </div>
  );
}

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
          <WelcomePlaceholder />
        </main>
      </div>
      <StatusBar left={<span>No project</span>} />
    </div>
  );
}
