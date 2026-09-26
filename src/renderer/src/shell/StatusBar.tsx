import type { ReactNode } from 'react';

/** Bottom status bar (24 px): core items on the left, plugin items and notifications on the right. */
export function StatusBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <footer
      data-testid="statusbar"
      className="flex h-(--statusbar-height) flex-none items-center justify-between gap-3 px-3 font-mono text-small text-fg-muted"
    >
      <div className="flex min-w-0 items-center gap-3">{left}</div>
      <div className="flex min-w-0 items-center gap-3">{right}</div>
    </footer>
  );
}
