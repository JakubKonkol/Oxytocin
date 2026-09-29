import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { cn } from '../../lib/cn';

interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  separator?: boolean;
}

interface MenuState {
  open: { items: MenuItem[]; x: number; y: number; resolve: (id: string | undefined) => void } | null;
}

const useMenuStore = create<MenuState>(() => ({ open: null }));

/** Context menu requested by a plugin view (`view.showContextMenu`); resolves with the chosen id. */
export function showViewContextMenu(items: MenuItem[], at: { x: number; y: number }): Promise<string | undefined> {
  useMenuStore.getState().open?.resolve(undefined);
  return new Promise((resolve) =>
    useMenuStore.setState({ open: { items: items.slice(0, 50), x: at.x, y: at.y, resolve } }),
  );
}

const MARGIN = 4;

/**
 * Where a menu opened at the pointer goes so that it stays inside the window: to the left of / above the pointer
 * when it does not fit to the right / below (e.g. a view in the right sidebar), then clamped to the window.
 */
export function fitMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const axis = (pos: number, extent: number, limit: number) => {
    let p = pos + extent > limit - MARGIN ? pos - extent : pos;
    p = Math.min(p, limit - extent - MARGIN);
    return Math.max(MARGIN, p);
  };
  return { x: axis(at.x, size.width, viewport.width), y: axis(at.y, size.height, viewport.height) };
}

function close(id: string | undefined) {
  const open = useMenuStore.getState().open;
  useMenuStore.setState({ open: null });
  open?.resolve(id);
}

export function ViewContextMenuHost() {
  const open = useMenuStore((s) => s.open);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // Measured before it is painted, then moved into the window.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) {
      setPosition(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setPosition(
      fitMenu(
        { x: open.x, y: open.y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [open]);
  // The click that opened it happened inside the plugin's iframe: take the focus (once visible) so Escape reaches
  // the menu.
  useEffect(() => {
    if (position) menuRef.current?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(undefined);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50"
      onPointerDown={() => close(undefined)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={menuRef}
        tabIndex={-1}
        role="menu"
        data-testid="plugin-context-menu"
        className="absolute max-h-[calc(100vh-8px)] min-w-44 overflow-y-auto rounded-control border border-line bg-elevated p-1 shadow-lg focus-visible:outline-none"
        style={{
          left: position?.x ?? open.x,
          top: position?.y ?? open.y,
          visibility: position ? 'visible' : 'hidden',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {open.items.map((item, i) =>
          item.separator ? (
            <div key={`sep-${i}`} className="my-1 h-px bg-line-subtle" />
          ) : (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => close(item.id)}
              className={cn(
                'flex h-7 w-full items-center rounded-badge px-2 text-left text-ui text-fg hover:bg-accent-muted',
                item.disabled && 'pointer-events-none text-fg-muted',
              )}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
