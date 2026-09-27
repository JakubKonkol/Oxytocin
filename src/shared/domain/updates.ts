import { z } from 'zod';

/** Release channels: stable only, or also pre-releases. */
export const UpdateChannelSchema = z.enum(['latest', 'beta']);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const UpdateStatusSchema = z.enum(['idle', 'checking', 'up-to-date', 'downloading', 'ready', 'error']);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/** Auto-update state shown in the status bar (M9-T2). */
export const UpdateStateSchema = z.object({
  currentVersion: z.string(),
  /** Why updates are unavailable (development build, a package without auto-update); absent when available. */
  disabledReason: z.string().optional(),
  status: UpdateStatusSchema,
  /** The newer version being downloaded or ready to install. */
  version: z.string().optional(),
  /** Download progress, 0–100. */
  percent: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
  /** Epoch ms of the last finished check. */
  lastCheck: z.number().optional(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;
