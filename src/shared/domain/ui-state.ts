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
  /** The text of the shared scratchpad (also used while no project is open). */
  text: z.string().max(SCRATCHPAD_MAX_LENGTH),
  /** One scratchpad for all projects; off gives every project its own. */
  shared: z.boolean().default(true),
  /** Texts of the per-project scratchpads by project id (while `shared` is off; empty ones are left out). */
  projects: z.record(z.string(), z.string().max(SCRATCHPAD_MAX_LENGTH)).default({}),
});
export type ScratchpadState = z.infer<typeof ScratchpadStateSchema>;

export const defaultScratchpad = (): ScratchpadState => ({ text: '', shared: true, projects: {} });

const perProject = (s: ScratchpadState, projectId: string | null | undefined): projectId is string =>
  !s.shared && !!projectId;

/** The text the scratchpad shows in a project (the shared one, or the project's own). */
export function scratchpadText(s: ScratchpadState, projectId: string | null | undefined): string {
  return perProject(s, projectId) ? (s.projects[projectId] ?? '') : s.text;
}

/**
 * Sets the text the scratchpad shows in a project. Scratchpads of projects that are no longer open
 * (`knownProjectIds`) are dropped on the way.
 */
export function withScratchpadText(
  s: ScratchpadState,
  projectId: string | null | undefined,
  text: string,
  knownProjectIds?: readonly string[],
): ScratchpadState {
  const value = text.slice(0, SCRATCHPAD_MAX_LENGTH);
  if (!perProject(s, projectId)) return { ...s, text: value };
  const projects = pruneScratchpads(s.projects, knownProjectIds);
  if (value) projects[projectId] = value;
  else delete projects[projectId];
  return { ...s, projects };
}

function pruneScratchpads(projects: Record<string, string>, known?: readonly string[]): Record<string, string> {
  if (!known) return { ...projects };
  return Object.fromEntries(Object.entries(projects).filter(([id]) => known.includes(id)));
}

/** Projects other than `projectId` whose own scratchpad has text (what sharing would replace). */
export function otherScratchpadsWithText(
  s: ScratchpadState,
  projectId: string | null | undefined,
  knownProjectIds?: readonly string[],
): string[] {
  if (s.shared) return [];
  return Object.entries(pruneScratchpads(s.projects, knownProjectIds))
    .filter(([id, text]) => id !== projectId && text.trim().length > 0)
    .map(([id]) => id);
}

/**
 * Turns sharing on or off. On: the text shown in `projectId` becomes the one shared scratchpad and the other
 * projects' scratchpads are discarded. Off: the project keeps the text it shows, other projects start empty.
 */
export function withScratchpadShared(
  s: ScratchpadState,
  shared: boolean,
  projectId: string | null | undefined,
): ScratchpadState {
  if (s.shared === shared) return s;
  if (shared) return { text: scratchpadText(s, projectId), shared: true, projects: {} };
  return { text: s.text, shared: false, projects: projectId && s.text ? { [projectId]: s.text } : {} };
}

export const PaneviewStateSchema = z.object({
  order: z.array(z.string()),
  sizes: z.record(z.string(), z.number()),
  collapsed: z.array(z.string()),
  hidden: z.array(z.string()),
});
export type PaneviewState = z.infer<typeof PaneviewStateSchema>;

/**
 * A tool in a sidebar: the scratchpad or a plugin panel (`contributes.panels`) moved or added there. The same panels
 * open in the workspace; tools move between the workspace and both sidebars by drag and drop.
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
  /** Tools moved into the left sidebar, between its own sections (their order lives in `paneview`). */
  primaryTools: z.array(SidebarToolSchema).max(50).default([]),
  scratchpad: ScratchpadStateSchema.default(defaultScratchpad),
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
    primaryTools: [],
    scratchpad: defaultScratchpad(),
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
  primaryTools: z.array(SidebarToolSchema).max(50).optional(),
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
    primaryTools: patch.primaryTools ?? state.primaryTools,
    scratchpad: patch.scratchpad ?? state.scratchpad,
    pluginViewState: patch.pluginViewState
      ? { ...state.pluginViewState, ...patch.pluginViewState }
      : state.pluginViewState,
    dismissedHints: patch.dismissedHints ?? state.dismissedHints,
    recentCommands: patch.recentCommands ?? state.recentCommands,
  };
}
