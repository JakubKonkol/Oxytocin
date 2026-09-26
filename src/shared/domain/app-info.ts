import { z } from 'zod';

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  /** Windows build number (e.g. 22631) for xterm's ConPTY heuristics; 0 elsewhere. */
  osBuild: z.number(),
  isPackaged: z.boolean(),
  versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string(), v8: z.string() }),
  userDataDir: z.string(),
  e2e: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const HostStateSchema = z.enum(['starting', 'running', 'restarting', 'failed', 'stopped']);
export type HostState = z.infer<typeof HostStateSchema>;

export const HostStatusSchema = z.object({
  name: z.string(),
  state: HostStateSchema,
  pid: z.number().nullable(),
  restarts: z.number(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;
