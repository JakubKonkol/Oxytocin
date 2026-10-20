import { z } from 'zod';
import { CodeMapDiagnosticsSchema, CodeMapSettingsSchema, CodeMapStatusSchema } from '../../domain/code-map';
import type { HostBaseEvents, HostBaseMethods } from './host-base';
import { CodeMapQuerySchema, CodeMapQueryResultSchema } from '../../domain/code-map-query';

export const CodeMapCheckoutSchema = z.object({ checkoutId: z.string().min(1).max(200) }).strict();
export const ConfigureCodeMapCheckoutSchema = z
  .object({
    checkoutId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    root: z.string().min(1).max(32768),
    mode: z.enum(['project', 'worktree']),
    excludedPaths: CodeMapSettingsSchema.shape.excludedPaths,
    ignoreInGit: CodeMapSettingsSchema.shape.ignoreInGit,
    gitPath: z.string().min(1).max(32768),
    removeGitignoreEntry: z.boolean().default(false),
  })
  .strict();
export type ConfigureCodeMapCheckout = z.infer<typeof ConfigureCodeMapCheckoutSchema>;

export const CodeMapHostContracts = {
  'instructions:edit': {
    params: z
      .object({
        root: z.string().min(1).max(32768),
        file: z.enum(['CLAUDE.md', 'AGENTS.md']),
        action: z.enum(['add', 'remove']),
      })
      .strict(),
    result: z.object({ changed: z.boolean() }),
  },
  'query:run': {
    params: CodeMapCheckoutSchema.extend({ requestId: z.string().min(1).max(200), query: CodeMapQuerySchema }),
    result: CodeMapQueryResultSchema,
  },
  'query:cancel': { params: z.object({ requestId: z.string().min(1).max(200) }).strict(), result: z.null() },
  'hints:update': {
    params: z
      .object({
        activeProjectId: z.string().nullable(),
        terminalProjectIds: z.array(z.string()).max(1000),
        reconcile: z.boolean().default(false),
      })
      .strict(),
    result: z.null(),
  },
  'checkout:configure': { params: ConfigureCodeMapCheckoutSchema, result: CodeMapStatusSchema },
  'checkout:remove': { params: CodeMapCheckoutSchema, result: z.null() },
  'checkout:rebuild': { params: CodeMapCheckoutSchema, result: CodeMapStatusSchema },
  'checkout:pause': { params: CodeMapCheckoutSchema, result: CodeMapStatusSchema },
  'checkout:resume': { params: CodeMapCheckoutSchema, result: CodeMapStatusSchema },
  'checkout:deleteData': {
    params: CodeMapCheckoutSchema.extend({ root: z.string().min(1).max(32768).optional() }),
    result: CodeMapStatusSchema,
  },
  'checkout:status': { params: CodeMapCheckoutSchema, result: CodeMapStatusSchema },
  'checkout:diagnostics': { params: CodeMapCheckoutSchema, result: CodeMapDiagnosticsSchema },
} as const;

export type CodeMapHostMethods = HostBaseMethods & {
  [K in keyof typeof CodeMapHostContracts]: (
    params: z.input<(typeof CodeMapHostContracts)[K]['params']>,
  ) => z.infer<(typeof CodeMapHostContracts)[K]['result']>;
};
export type CodeMapHostEvents = HostBaseEvents & { 'checkout:status': z.infer<typeof CodeMapStatusSchema> };
