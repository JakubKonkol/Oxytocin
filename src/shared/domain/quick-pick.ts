import { z } from 'zod';

export const QUICK_PICK_MAX_ITEMS = 5000;

export const QuickPickItemSchema = z.object({
  label: z.string().max(500),
  description: z.string().max(500).optional(),
  detail: z.string().max(1000).optional(),
});
export type QuickPickItem = z.infer<typeof QuickPickItemSchema>;

/** A pick shown in the command palette on behalf of a plugin (`oxy.ui.showQuickPick`). */
export const QuickPickRequestSchema = z.object({
  requestId: z.string().min(1).max(100),
  items: z.array(QuickPickItemSchema).max(QUICK_PICK_MAX_ITEMS),
  placeholder: z.string().max(200).optional(),
  /** Who asked (plugin display name), shown in the palette. */
  source: z.string().max(200).optional(),
});
export type QuickPickRequest = z.infer<typeof QuickPickRequestSchema>;

export const QuickPickResultSchema = z.object({
  requestId: z.string().min(1).max(100),
  /** Index of the chosen item; null when the pick was dismissed. */
  index: z.number().int().min(0).nullable(),
});
export type QuickPickResult = z.infer<typeof QuickPickResultSchema>;
