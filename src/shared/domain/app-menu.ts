import { z } from 'zod';

/** Renderer commands the native application menu can run (macOS menu bar); nothing else is reachable from it. */
export const MENU_COMMANDS = [
  'workbench.about',
  'workbench.checkForUpdates',
  'workbench.openSettings',
  'workbench.commandPalette',
  'workbench.showShortcuts',
] as const;

export const MenuCommandSchema = z.enum(MENU_COMMANDS);
export type MenuCommand = z.infer<typeof MenuCommandSchema>;
