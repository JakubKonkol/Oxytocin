import { z } from 'zod';

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 520;
export const SIDEBAR_DEFAULT_WIDTH = 300;

export const WindowStateSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().min(400),
  height: z.number().int().min(300),
  maximized: z.boolean(),
  displayId: z.number().optional(),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

export const SidebarStateSchema = z.object({
  width: z.number().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
  collapsed: z.boolean(),
});
export type SidebarState = z.infer<typeof SidebarStateSchema>;

export const PaneviewStateSchema = z.object({
  order: z.array(z.string()),
  sizes: z.record(z.string(), z.number()),
  collapsed: z.array(z.string()),
  hidden: z.array(z.string()),
});
export type PaneviewState = z.infer<typeof PaneviewStateSchema>;

/** userData/ui-state.json (docs/plan/09-persistence-settings.md §7). */
export const UiStateSchema = z.object({
  version: z.literal(1),
  window: WindowStateSchema,
  sidebar: SidebarStateSchema,
  paneview: PaneviewStateSchema,
  pluginViewState: z.record(z.string(), z.unknown()),
  dismissedHints: z.array(z.string()),
  /** Command ids run from the command palette, most recent first (docs/plan/02-ui-ux.md §8). */
  recentCommands: z.array(z.string()).max(50).default([]),
});
export type UiState = z.infer<typeof UiStateSchema>;

export function defaultUiState(): UiState {
  return {
    version: 1,
    window: { width: 1280, height: 800, maximized: false },
    sidebar: { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false },
    paneview: { order: [], sizes: {}, collapsed: [], hidden: [] },
    pluginViewState: {},
    dismissedHints: [],
    recentCommands: [],
  };
}

/** What the renderer may change (window bounds are owned by main). */
export const UiStatePatchSchema = z.object({
  sidebar: SidebarStateSchema.partial().optional(),
  paneview: PaneviewStateSchema.optional(),
  pluginViewState: z.record(z.string(), z.unknown()).optional(),
  dismissedHints: z.array(z.string()).optional(),
  recentCommands: z.array(z.string()).max(50).optional(),
});
export type UiStatePatch = z.infer<typeof UiStatePatchSchema>;

export function applyUiStatePatch(state: UiState, patch: UiStatePatch): UiState {
  return {
    ...state,
    sidebar: patch.sidebar ? SidebarStateSchema.parse({ ...state.sidebar, ...patch.sidebar }) : state.sidebar,
    paneview: patch.paneview ?? state.paneview,
    pluginViewState: patch.pluginViewState
      ? { ...state.pluginViewState, ...patch.pluginViewState }
      : state.pluginViewState,
    dismissedHints: patch.dismissedHints ?? state.dismissedHints,
    recentCommands: patch.recentCommands ?? state.recentCommands,
  };
}
