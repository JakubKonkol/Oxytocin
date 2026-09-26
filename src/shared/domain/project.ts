import { z } from 'zod';
import { ProjectIdSchema } from './terminal';

export { ProjectIdSchema };
export type { ProjectId } from './terminal';

export const PROJECT_COLOR_COUNT = 10;
/** CSS values of the project palette (mirrors `--project-0…9` in tokens.css) for plugins and native UI. */
export const PROJECT_COLOR_VALUES = [
  '#4f8cff',
  '#22c55e',
  '#f5a524',
  '#ef4444',
  '#a78bfa',
  '#38bdf8',
  '#f472b6',
  '#14b8a6',
  '#eab308',
  '#fb923c',
] as const;

export const StartupTerminalSchema = z.object({
  name: z.string().optional(),
  profileId: z.string().optional(),
  command: z.string().optional(),
  /** Relative to the project root. */
  cwd: z.string().optional(),
  placement: z.enum(['tab', 'right', 'below']).optional(),
});
export type StartupTerminal = z.infer<typeof StartupTerminalSchema>;

export const ProjectSettingsSchema = z.object({
  defaultProfileId: z.string().optional(),
  env: z.record(z.string(), z.string().nullable()).optional(),
  startupTerminals: z.array(StartupTerminalSchema).optional(),
  editorCommand: z.string().optional(),
  git: z.object({ enabled: z.boolean().optional(), ignoredFolders: z.array(z.string()).optional() }).optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectIconSchema = z.object({ kind: z.enum(['letter', 'emoji']), value: z.string().min(1).max(8) });

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string().min(1).max(200),
  /** Absolute, normalized, without a trailing separator. */
  rootPath: z.string().min(1),
  /** Index into the project palette (tokens --project-0 … --project-9). */
  color: z
    .number()
    .int()
    .min(0)
    .max(PROJECT_COLOR_COUNT - 1),
  icon: ProjectIconSchema.optional(),
  pinned: z.boolean(),
  order: z.number(),
  createdAt: z.number(),
  lastOpenedAt: z.number().optional(),
  /** Runtime only: the folder does not exist (never persisted). */
  missing: z.boolean().optional(),
  settings: ProjectSettingsSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectPatchSchema = z.object({
  id: ProjectIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  color: z
    .number()
    .int()
    .min(0)
    .max(PROJECT_COLOR_COUNT - 1)
    .optional(),
  icon: ProjectIconSchema.nullable().optional(),
  pinned: z.boolean().optional(),
  settings: ProjectSettingsSchema.optional(),
  /** "Locate folder…" for a missing project (keeps id, layout and usage history). */
  rootPath: z.string().min(1).optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

export const ProjectsFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectSchema.omit({ missing: true })),
  activeProjectId: ProjectIdSchema.nullable(),
});
export type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

export const AddProjectResultSchema = z.object({
  project: ProjectSchema,
  /** The folder was already a project (it was activated instead). */
  existed: z.boolean(),
  /** e.g. nested inside another project. */
  warning: z.string().optional(),
});
export type AddProjectResult = z.infer<typeof AddProjectResultSchema>;

export const ProjectActivitySchema = z.enum(['none', 'idle', 'running', 'agent-working', 'attention', 'error']);
export type ProjectActivity = z.infer<typeof ProjectActivitySchema>;

/** Stable palette index from the root path. */
export function colorForPath(rootPath: string): number {
  let hash = 0;
  for (let i = 0; i < rootPath.length; i++) hash = (hash * 31 + rootPath.charCodeAt(i)) >>> 0;
  return hash % PROJECT_COLOR_COUNT;
}
