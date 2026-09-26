import { z } from 'zod';
import { AgentInfoSchema } from './agent';

export const TerminalIdSchema = z.string().min(1).max(64);
export type TerminalId = z.infer<typeof TerminalIdSchema>;

/** OSC 9;4 progress state: 0 hidden, 1 normal, 2 error, 3 indeterminate, 4 paused/warning. */
export type ProgressState = 0 | 1 | 2 | 3 | 4;

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

/** Everything the PTY Host needs to start a terminal (composed by TerminalService in main). */
export const SpawnOptionsSchema = z.object({
  id: TerminalIdSchema,
  file: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
  scrollback: z.number().int().min(0).max(100_000),
  /** Windows only: use the bundled conpty.dll / OpenConsole.exe (node-pty `useConptyDll`). */
  useConptyDll: z.boolean().optional(),
  /** VT data written to the mirror before any PTY output (restored scrollback). */
  restoreData: z.string().optional(),
  /** Typed into the shell after its first output (agent profiles, startup commands). */
  initialCommand: z.string().optional(),
});
export type SpawnOptions = z.infer<typeof SpawnOptionsSchema>;

export interface TerminalSnapshot {
  seq: number;
  data: string;
  cols: number;
  rows: number;
}

export const ProjectIdSchema = z.string().min(1).max(64);
export type ProjectId = z.infer<typeof ProjectIdSchema>;

/** Until projects exist (M3) terminals belong to this pseudo-project rooted at the home directory. */
export const DEFAULT_PROJECT_ID = 'default';

export const TerminalKindSchema = z.enum(['shell', 'process', 'agent']);
export type TerminalKind = z.infer<typeof TerminalKindSchema>;

export const TerminalStateSchema = z.enum(['running', 'exited', 'failed']);
export type TerminalState = z.infer<typeof TerminalStateSchema>;

export const TerminalInfoSchema = z.object({
  id: TerminalIdSchema,
  projectId: ProjectIdSchema,
  profileId: z.string(),
  profileName: z.string(),
  /** Title shown in the UI: userTitle ?? oscTitle ?? profileName. */
  title: z.string(),
  userTitle: z.string().optional(),
  oscTitle: z.string().optional(),
  pid: z.number().nullable(),
  cwd: z.string(),
  shellType: z.string(),
  kind: TerminalKindSchema,
  state: TerminalStateSchema,
  exitCode: z.number().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  envStale: z.boolean(),
  bell: z.boolean(),
  progress: z.object({ state: z.number().int().min(0).max(4), value: z.number().optional() }).optional(),
  /** Nearest non-shell descendant (e.g. `node` of `npm run dev`). */
  foreground: z.object({ pid: z.number(), name: z.string(), commandLine: z.string() }).optional(),
  agent: AgentInfoSchema.optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const CreateTerminalRequestSchema = z.object({
  projectId: ProjectIdSchema,
  profileId: z.string().optional(),
  cwd: z.string().optional(),
  cols: z.number().int().min(2).max(1000).optional(),
  rows: z.number().int().min(1).max(500).optional(),
  userTitle: z.string().max(80).optional(),
  initialCommand: z.string().max(10_000).optional(),
  /** Restores the scrollback snapshot saved for this panel at the last quit (read by main). */
  restoreScrollback: z.object({ panelId: z.string().regex(/^[a-z]+-[a-z0-9]+$/) }).optional(),
});
export type CreateTerminalRequest = z.infer<typeof CreateTerminalRequestSchema>;
