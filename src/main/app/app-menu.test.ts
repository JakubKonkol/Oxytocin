import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

vi.mock('electron', () => ({ Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() } }));

const { appMenuTemplate } = await import('./app-menu');

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

const roles = (items: MenuItemConstructorOptions[]) =>
  flatten(items)
    .map((i) => i.role)
    .filter(Boolean);

const accelerators = (items: MenuItemConstructorOptions[]) =>
  flatten(items)
    .map((i) => i.accelerator)
    .filter(Boolean);

const base = { appName: 'Oxytocin', run: vi.fn(), openLogsFolder: vi.fn() };

describe('appMenuTemplate', () => {
  it.each(['win32', 'linux'] as const)('keeps no reload, DevTools or close shortcuts in packaged builds (%s)', (p) => {
    const menu = appMenuTemplate({ ...base, platform: p, dev: false });
    expect(roles(menu)).toEqual(['togglefullscreen']);
    expect(accelerators(menu)).toEqual(['F11']);
  });

  it('keeps reload and DevTools in development builds', () => {
    const menu = appMenuTemplate({ ...base, platform: 'win32', dev: true });
    expect(roles(menu)).toEqual(['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']);
  });

  it('builds the native macOS menu with the editing roles and without Close Window', () => {
    const menu = appMenuTemplate({ ...base, platform: 'darwin', dev: false });
    expect(menu.map((m) => m.label ?? m.role)).toEqual(['Oxytocin', 'Edit', 'View', 'Window', 'help']);
    const r = roles(menu);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit', 'hide', 'minimize'] as const) {
      expect(r).toContain(role);
    }
    expect(r).not.toContain('close');
    expect(r).not.toContain('reload');
    expect(r).not.toContain('toggleDevTools');
  });

  it('runs renderer commands from the macOS menu', () => {
    const run = vi.fn();
    const openLogsFolder = vi.fn();
    const menu = appMenuTemplate({ ...base, run, openLogsFolder, platform: 'darwin', dev: false });
    const click = (label: string) => {
      const item = flatten(menu).find((i) => i.label === label);
      (item?.click as () => void)();
    };
    click('About Oxytocin');
    click('Settings…');
    click('Check for Updates…');
    click('Command Palette…');
    click('Show Logs Folder');
    expect(run.mock.calls).toEqual([
      ['workbench.about'],
      ['workbench.openSettings'],
      ['workbench.checkForUpdates'],
      ['workbench.commandPalette'],
    ]);
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
  });
});
