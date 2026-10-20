import { z } from 'zod';
import { CodeMapRefSchema } from './code-map-plugin';
import { CodeMapRelativePathSchema } from './code-map';
import { ChangeStatusSchema } from './git';

export const GitCheckoutChangesSchema = CodeMapRefSchema.extend({
  comparison: z.enum(['head', 'worktree-base']),
  baseCommit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  files: z
    .array(
      z
        .object({
          path: CodeMapRelativePathSchema,
          oldPath: CodeMapRelativePathSchema.optional(),
          status: ChangeStatusSchema,
        })
        .strict(),
    )
    .max(500),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();
