import { z } from 'zod';

/** A confirmation the main process asks the user in the window (e.g. quitting with running processes). */
export const ConfirmRequestSchema = z.object({
  requestId: z.string().min(1).max(100),
  title: z.string().max(300),
  description: z.string().max(2000).optional(),
  /** Items the confirmation is about, shown as a list. */
  details: z.array(z.string().max(500)).max(50).optional(),
  confirmLabel: z.string().max(60).optional(),
  cancelLabel: z.string().max(60).optional(),
  destructive: z.boolean().optional(),
  tone: z.enum(['info', 'warning', 'danger']).optional(),
  checkbox: z.object({ label: z.string().max(200), defaultChecked: z.boolean() }).optional(),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

export const ConfirmResultSchema = z.object({
  requestId: z.string().min(1).max(100),
  confirmed: z.boolean(),
  checked: z.boolean(),
});
export type ConfirmResult = z.infer<typeof ConfirmResultSchema>;
