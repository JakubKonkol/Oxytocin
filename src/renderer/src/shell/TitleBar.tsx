import { DropdownMenu } from 'radix-ui';
import appIconSmall from '../assets/brand/app-icon-small.svg';
import { useHelpStore } from '../features/help/HelpDialogs';
import { openPluginsManager } from '../features/plugins/plugin-manager';
import { currentPlatform } from '../lib/platform';

const menuItem =
  'flex h-7 cursor-default items-center rounded-badge px-2 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';

/** App menu behind the logo (the window has no native menu bar): About, notices, plugins. */
function AppMenu() {
  const show = useHelpStore((s) => s.show);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="app-menu"
          aria-label="Oxytocin menu"
          className="oxy-no-drag flex items-center gap-2 rounded-badge px-1 py-0.5 hover:bg-card-hover focus-visible:bg-card-hover"
        >
          <img src={appIconSmall} alt="" aria-hidden width={16} height={16} draggable={false} />
          <span className="font-mono text-small font-semibold tracking-[0.08em] text-fg-secondary uppercase">
            Oxytocin
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-lg"
        >
          <DropdownMenu.Item className={menuItem} onSelect={() => openPluginsManager()}>
            Plugins
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
          <DropdownMenu.Item className={menuItem} onSelect={() => show('notices')}>
            Third-Party Notices
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => show('about')}>
            About Oxytocin
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

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
      <AppMenu />
      <div className="pointer-events-none absolute inset-x-0 text-center font-mono text-small text-fg-muted">
        {title}
      </div>
    </header>
  );
}
