import { useEffect } from 'react';
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

function close(id: string | undefined) {
  const open = useMenuStore.getState().open;
  useMenuStore.setState({ open: null });
  open?.resolve(id);
}

export function ViewContextMenuHost() {
  const open = useMenuStore((s) => s.open);
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
        role="menu"
        data-testid="plugin-context-menu"
        className="absolute min-w-44 rounded-control border border-line bg-elevated p-1 shadow-lg"
        style={{ left: open.x, top: open.y }}
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
