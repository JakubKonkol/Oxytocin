import { z } from 'zod';

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
