import { z } from 'zod';
import { ProjectIdSchema } from './terminal';

export const PanelDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('terminal'),
    terminalId: z.string().optional(),
    profileId: z.string(),
    cwd: z.string(),
    userTitle: z.string().optional(),
    agent: z.object({ agentId: z.string(), sessionId: z.string().optional() }).optional(),
    /** Relative path of the scrollback snapshot written at quit (workspaces/<projectId>/scrollback/<panelId>.vt). */
    scrollbackFile: z.string().optional(),
  }),
  z.object({ kind: z.literal('diff'), path: z.string(), oldPath: z.string().optional(), pinned: z.boolean() }),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string(),
    panelType: z.string(),
    params: z.unknown().optional(),
    state: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('welcome') }),
]);
export type PanelDescriptor = z.infer<typeof PanelDescriptorSchema>;

/** userData/workspaces/<projectId>.json (docs/plan/03-projects-workspace.md §7). */
export const WorkspaceStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  savedAt: z.number(),
  /** DockviewApi.toJSON() — validated loosely; dockview validates it on fromJSON. */
  dockview: z.record(z.string(), z.unknown()),
  panels: z.record(z.string(), PanelDescriptorSchema),
  activePanelId: z.string().optional(),
  ui: z
    .object({
      changes: z
        .object({ expanded: z.array(z.string()), mode: z.enum(['tree', 'list']), filter: z.string().optional() })
        .optional(),
    })
    .default({}),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const WorkspaceLoadResultSchema = z.object({
  state: WorkspaceStateSchema.nullable(),
  /** Set when the saved file was unreadable and had to be discarded. */
  problem: z.string().optional(),
});
export type WorkspaceLoadResult = z.infer<typeof WorkspaceLoadResultSchema>;

/** Panel ids become file names of scrollback snapshots. */
export const PANEL_ID_PATTERN = /^[a-z]+-[a-z0-9]+$/;
