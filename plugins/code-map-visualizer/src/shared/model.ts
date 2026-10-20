import { z } from 'zod';
import type { CodeMapCheckout, CodeMapResponse, GitCheckoutChanges } from '@oxytocin/plugin-api';

export const SelectionSchema = z
  .object({
    view: z
      .enum(['overview', 'file', 'neighborhood', 'search', 'changes', 'impact', 'knowledge', 'task-context'])
      .default('overview'),
    receipt: z.string().min(1).max(200).optional(),
    learningState: z.enum(['active', 'pending', 'stale', 'all']).default('active'),
    checkoutId: z.string().min(1).max(200).optional(),
    root: z
      .union([
        z.object({ path: z.string().min(1).max(4096) }).strict(),
        z.object({ symbolId: z.string().min(1).max(8192) }).strict(),
      ])
      .optional(),
    query: z.string().max(2000).default(''),
    generation: z.number().int().nonnegative().optional(),
    direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
    relations: z
      .array(z.enum(['contains', 'imports', 'exports', 'calls', 'references', 'extends', 'implements']))
      .min(1)
      .max(7)
      .default(['imports', 'references', 'calls', 'exports', 'extends', 'implements']),
    includeHeuristic: z.boolean().default(false),
    depth: z.number().int().min(1).max(3).default(1),
  })
  .strict();
export type Selection = z.infer<typeof SelectionSchema>;
export interface Model {
  project: { id: string; name: string } | null;
  checkouts: CodeMapCheckout[];
  initial?: Selection;
}
export interface Answer {
  projectId: string;
  response: CodeMapResponse;
  changes?: GitCheckoutChanges;
  changeRootsTruncated?: boolean;
}
