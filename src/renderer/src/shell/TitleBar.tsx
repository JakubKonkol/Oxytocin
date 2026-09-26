import { currentPlatform } from '../lib/platform';

/**
 * Custom title bar (36 px). The whole bar is a window drag region; interactive children must use `oxy-no-drag`.
 * Right padding leaves room for the Windows/Linux window controls overlay (titlebar-area env variables).
 */
export function TitleBar({ title }: { title: string }) {
  const isMac = currentPlatform() === 'darwin';
  return (
    <header
      data-testid="titlebar"
      className="oxy-drag relative flex h-(--titlebar-height) flex-none items-center gap-2 pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw))]"
      style={{ paddingLeft: isMac ? 80 : 12 }}
    >
      <div className="flex items-center gap-2">
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="text-line-focus">
          <path d="M7 0 14 7 7 14 0 7Z" fill="currentColor" />
        </svg>
        <span className="font-mono text-small font-semibold tracking-[0.08em] text-fg-secondary uppercase">
          Oxytocin
        </span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 text-center font-mono text-small text-fg-muted">
        {title}
      </div>
    </header>
  );
}
