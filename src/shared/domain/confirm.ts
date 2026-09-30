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
  /** A third button between Cancel and Confirm (e.g. "Always allow"); its click is reported as `secondary`. */
  secondaryLabel: z.string().max(60).optional(),
  /** Monospace text shown in a scrollable block (e.g. a tool's arguments). */
  code: z.string().max(20_000).optional(),
  /** Asks for an answer: one of `options`, or free text. The answer comes back as `value`. */
  input: z
    .union([
      z.object({ kind: z.literal('options'), options: z.array(z.string().min(1).max(200)).min(2).max(10) }),
      z.object({ kind: z.literal('text'), placeholder: z.string().max(200).optional() }),
    ])
    .optional(),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

export const ConfirmResultSchema = z.object({
  requestId: z.string().min(1).max(100),
  confirmed: z.boolean(),
  checked: z.boolean(),
  /** The secondary button was clicked (`confirmed` is true as well). */
  secondary: z.boolean().optional(),
  value: z.string().max(10_000).optional(),
});
export type ConfirmResult = z.infer<typeof ConfirmResultSchema>;
