import { useRef } from 'react';
import { clampSidebarWidth, useUiStore } from '../stores/ui-store';

/** Vertical drag handle between the sidebar and the center area. */
export function SidebarResizer() {
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-testid="sidebar-resizer"
      className="group relative w-2 flex-none cursor-col-resize"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: useUiStore.getState().state.sidebar.width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        setWidth(clampSidebarWidth(start.current.width + e.clientX - start.current.x));
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
