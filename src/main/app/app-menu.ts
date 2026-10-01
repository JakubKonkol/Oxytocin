import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@shared/domain/app-menu';

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  /** Development builds keep Reload and the DevTools shortcuts. */
  dev: boolean;
  /** Runs a renderer command (About, Settings, …). */
  run: (command: MenuCommand) => void;
  openLogsFolder: () => void;
}

/**
 * The application menu per platform. Replaces Electron's default menu, whose View and Window items would
 * otherwise act on keys the page does not handle: Ctrl+R / Cmd+R reloading the whole shell, Ctrl+Shift+I opening
 * the DevTools and Ctrl+W closing (quitting) the window in packaged builds.
 *
 * - macOS: the native menu bar (App, Edit, View, Window, Help). Edit roles are required there for Cmd+C/V/X/A/Z in
 *   text fields. Shortcuts the renderer owns (Cmd+,, Cmd+Shift+P) reach the page first; the menu only acts when the
 *   page leaves the key unhandled, or when the item is clicked.
 * - Windows/Linux: the window has its own title bar and no menu bar; Chromium handles the editing keys itself. Only
 *   full screen (F11) stays, plus Reload and DevTools in development builds.
 */
export function appMenuTemplate(o: AppMenuOptions): MenuItemConstructorOptions[] {
  const devItems: MenuItemConstructorOptions[] = o.dev
    ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
    : [];
  if (o.platform !== 'darwin') {
    return [{ label: 'View', submenu: [...devItems, { role: 'togglefullscreen', accelerator: 'F11' }] }];
  }
  return [
    {
      label: o.appName,
      submenu: [
        { label: `About ${o.appName}`, click: () => o.run('workbench.about') },
        { label: 'Check for Updates…', click: () => o.run('workbench.checkForUpdates') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => o.run('workbench.openSettings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'Shift+Cmd+P', click: () => o.run('workbench.commandPalette') },
        { type: 'separator' },
        ...devItems,
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      role: 'help',
      submenu: [{ label: 'Show Logs Folder', click: () => o.openLogsFolder() }],
    },
  ];
}

/** Installs the application menu (call once the app is ready). */
export function installAppMenu(o: AppMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(o)));
}
