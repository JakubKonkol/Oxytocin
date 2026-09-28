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

/** Scratchpad text is capped so ui-state.json stays small. */
export const SCRATCHPAD_MAX_LENGTH = 100_000;

export const ScratchpadStateSchema = z.object({
  text: z.string().max(SCRATCHPAD_MAX_LENGTH),
});
export type ScratchpadState = z.infer<typeof ScratchpadStateSchema>;

export const PaneviewStateSchema = z.object({
  order: z.array(z.string()),
  sizes: z.record(z.string(), z.number()),
  collapsed: z.array(z.string()),
  hidden: z.array(z.string()),
});
export type PaneviewState = z.infer<typeof PaneviewStateSchema>;

/**
 * A tool in the right sidebar: the scratchpad or a plugin panel (`contributes.panels`) moved or added there. The
 * same panels open in the workspace; tools move between both by drag and drop.
 */
export const SidebarToolSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('scratchpad') }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('plugin'),
    pluginId: z.string(),
    panelType: z.string(),
    /** Instance id of the view (keys its `oxy.setState` state in `pluginViewState`). */
    viewId: z.string(),
    title: z.string().optional(),
    params: z.unknown().optional(),
  }),
]);
export type SidebarTool = z.infer<typeof SidebarToolSchema>;

export const DEFAULT_SIDEBAR_TOOLS: SidebarTool[] = [{ id: 'scratchpad', kind: 'scratchpad' }];

/** userData/ui-state.json. */
export const UiStateSchema = z.object({
  version: z.literal(1),
  window: WindowStateSchema,
  sidebar: SidebarStateSchema,
  paneview: PaneviewStateSchema,
  /** Right-hand column (scratchpad and future tools); same width limits as the left sidebar. */
  secondarySidebar: SidebarStateSchema.default({ width: SIDEBAR_DEFAULT_WIDTH, collapsed: false }),
  secondaryPaneview: PaneviewStateSchema.default({ order: [], sizes: {}, collapsed: [], hidden: [] }),
  /** Tools of the right sidebar, top to bottom (sizes and collapsed state live in `secondaryPaneview`). */
  secondaryTools: z
    .array(SidebarToolSchema)
    .max(50)
    .default(() => DEFAULT_SIDEBAR_TOOLS.map((t) => ({ ...t }))),
  scratchpad: ScratchpadStateSchema.default({ text: '' }),
  pluginViewState: z.record(z.string(), z.unknown()),
  dismissedHints: z.array(z.string()),
  /** Command ids run from the command palette, most recent first. */
  recentCommands: z.array(z.string()).max(50).default([]),
});
export type UiState = z.infer<typeof UiStateSchema>;

export function defaultUiState(): UiState {
  return {
    version: 1,
    window: { width: 1280, height: 800, maximized: false },
    sidebar: { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false },
    paneview: { order: [], sizes: {}, collapsed: [], hidden: [] },
    secondarySidebar: { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false },
    secondaryPaneview: { order: [], sizes: {}, collapsed: [], hidden: [] },
    secondaryTools: DEFAULT_SIDEBAR_TOOLS.map((t) => ({ ...t })),
    scratchpad: { text: '' },
    pluginViewState: {},
    dismissedHints: [],
    recentCommands: [],
  };
}

/** What the renderer may change (window bounds are owned by main). */
export const UiStatePatchSchema = z.object({
  sidebar: SidebarStateSchema.partial().optional(),
  paneview: PaneviewStateSchema.optional(),
  secondarySidebar: SidebarStateSchema.partial().optional(),
  secondaryPaneview: PaneviewStateSchema.optional(),
  secondaryTools: z.array(SidebarToolSchema).max(50).optional(),
  scratchpad: ScratchpadStateSchema.optional(),
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
    secondarySidebar: patch.secondarySidebar
      ? SidebarStateSchema.parse({ ...state.secondarySidebar, ...patch.secondarySidebar })
      : state.secondarySidebar,
    secondaryPaneview: patch.secondaryPaneview ?? state.secondaryPaneview,
    secondaryTools: patch.secondaryTools ?? state.secondaryTools,
    scratchpad: patch.scratchpad ?? state.scratchpad,
    pluginViewState: patch.pluginViewState
      ? { ...state.pluginViewState, ...patch.pluginViewState }
      : state.pluginViewState,
    dismissedHints: patch.dismissedHints ?? state.dismissedHints,
    recentCommands: patch.recentCommands ?? state.recentCommands,
  };
}
