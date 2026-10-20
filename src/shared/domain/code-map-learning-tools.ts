import { z } from 'zod';
import { CodeMapRelativePathSchema } from './code-map';
import { CodeMapFreshnessModeSchema, CodeMapFreshnessSchema } from './code-map-query';
import { CodeMapSliceEdgeSchema, CodeMapSliceNodeSchema } from './code-map-plugin';
import { LearningDraftSchema, LearningSchema, LearningReferenceSchema } from './code-map-memory';

const key = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
export const LearningActorSchema = z.object({ session: key, principal: key, role: key, task: key.optional() }).strict();
export type LearningActor = z.infer<typeof LearningActorSchema>;
export const TaskContextQuerySchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    paths: z.array(CodeMapRelativePathSchema).max(8).default([]),
    symbolIds: z.array(z.string().min(1).max(8192)).max(8).default([]),
    maxChars: z.number().int().min(1).max(24000).default(8000),
    freshness: CodeMapFreshnessModeSchema.default('latest'),
  })
  .strict()
  .refine((v) => v.paths.length + v.symbolIds.length <= 8, 'At most eight anchors');
export const ProposeLearningSchema = z
  .object({
    draft: LearningDraftSchema,
    expectedRevision: z.literal(0),
    idempotencyKey: key,
  })
  .strict();
export const LearningFeedbackSchema = z
  .object({
    receipt: key,
    id: key,
    revision,
    outcome: z.enum(['used', 'irrelevant', 'outdated', 'incorrect']),
    reason: z.string().max(500).optional(),
    evidence: LearningDraftSchema.shape.evidence,
    idempotencyKey: key,
  })
  .strict();
export const LearningToolRequestSchema = z.discriminatedUnion('kind', [
  TaskContextQuerySchema.safeExtend({ kind: z.literal('task-context') }),
  ProposeLearningSchema.extend({ kind: z.literal('propose') }),
  LearningFeedbackSchema.extend({ kind: z.literal('feedback') }),
]);
export type LearningToolRequest = z.input<typeof LearningToolRequestSchema>;
export const ContextLearningSchema = LearningReferenceSchema;
export const TaskContextResultSchema = z
  .object({
    kind: z.literal('task-context'),
    code: z.literal('OK'),
    checkoutId: key,
    generation: revision,
    memoryRevision: revision,
    freshness: CodeMapFreshnessSchema,
    memory: z.enum(['ready', 'off', 'unavailable']),
    nodes: z.array(CodeMapSliceNodeSchema).max(100),
    relations: z.array(CodeMapSliceEdgeSchema).max(100),
    learnings: z.array(ContextLearningSchema).max(3),
    receipt: key.optional(),
    omitted: z.object({ code: revision, relations: revision, learnings: revision, inapplicable: revision }).strict(),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(500)).max(8),
  })
  .strict();
export type TaskContextResult = z.infer<typeof TaskContextResultSchema>;
export const LearningToolErrorSchema = z
  .object({
    kind: z.literal('error'),
    code: z.enum([
      'UNAVAILABLE',
      'MEMORY_OFF',
      'MEMORY_UNAVAILABLE',
      'BUDGET_TOO_SMALL',
      'RATE_LIMIT',
      'EVIDENCE_CHANGED',
      'INVALID_EVIDENCE',
      'REVISION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'CONFLICT',
      'MEMORY_LIMIT',
      'RECEIPT_EXPIRED',
      'INVALID_RECEIPT',
      'SNAPSHOT_CHANGED',
      'CANCELLED',
    ]),
    message: z.string().max(500),
  })
  .strict();
export const LearningMutationResultSchema = z
  .object({
    kind: z.enum(['propose', 'feedback']),
    code: z.literal('OK'),
    id: key,
    revision,
    memoryRevision: revision,
    review: LearningSchema.shape.review,
    applicability: z.enum(['current', 'needs-review', 'pending']),
    duplicate: z.boolean(),
  })
  .strict();
export const LearningToolResultSchema = z.union([
  TaskContextResultSchema,
  LearningMutationResultSchema,
  LearningToolErrorSchema,
]);
export type LearningToolResult = z.infer<typeof LearningToolResultSchema>;

/** Internal mutation, only constructed after validating the session-bound receipt. */
export const LearningFeedbackMutationSchema = LearningFeedbackSchema.omit({ receipt: true, revision: true })
  .extend({
    action: z.literal('feedback'),
    expectedRevision: revision,
    receiptKey: key,
  })
  .strict();
export type LearningFeedbackMutation = z.infer<typeof LearningFeedbackMutationSchema>;
