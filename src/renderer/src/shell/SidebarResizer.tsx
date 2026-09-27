import { useRef } from 'react';
import { clampSidebarWidth, useUiStore } from '../stores/ui-store';

/**
 * Vertical drag handle between a sidebar and the center area. The left sidebar grows when dragged right,
 * the right one (`side="right"`) when dragged left.
 */
export function SidebarResizer({ side = 'left' }: { side?: 'left' | 'right' }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const right = side === 'right';
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={right ? 'Resize right sidebar' : 'Resize sidebar'}
      data-testid={right ? 'secondary-sidebar-resizer' : 'sidebar-resizer'}
      className="group relative w-2 flex-none cursor-col-resize"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const state = useUiStore.getState().state;
        start.current = { x: e.clientX, width: right ? state.secondarySidebar.width : state.sidebar.width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = e.clientX - start.current.x;
        const width = clampSidebarWidth(start.current.width + (right ? -delta : delta));
        const store = useUiStore.getState();
        if (right) store.setSecondarySidebarWidth(width);
        else store.setSidebarWidth(width);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        start.current = null;
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent" />
    </div>
  );
}
