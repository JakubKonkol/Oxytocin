import { z } from 'zod';
import { CodeMapHashSchema, CodeMapRelativePathSchema, CodeMapSpanSchema } from './code-map';

const key = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const provenance = z.object({ source: z.enum(['user', 'agent']), role: key.optional(), task: key.optional() }).strict();
export const LearningCheckoutSchema = z.object({ checkoutId: key, archived: z.boolean() }).strict();
export const LearningDraftSchema = z
  .object({
    kind: z.enum(['constraint', 'decision', 'pitfall', 'validation', 'failed-approach']),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(1500),
    rationale: z.string().max(1200).default(''),
    topic: z.string().trim().max(160).optional(),
    evidence: z
      .array(
        z
          .object({
            path: CodeMapRelativePathSchema,
            symbolId: z.string().max(8192).optional(),
            span: CodeMapSpanSchema.optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    replaces: key.optional(),
  })
  .strict();
export const LearningSchema = LearningDraftSchema.extend({
  id: key,
  revision,
  dedup: CodeMapHashSchema,
  evidence: z.array(LearningDraftSchema.shape.evidence.unwrap().element.extend({ hash: CodeMapHashSchema })).max(8),
  projectId: key,
  checkoutId: key,
  scope: z.enum(['checkout', 'project']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  origin: provenance,
  editor: provenance.optional(),
  reviewer: provenance.optional(),
  review: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  reviewedAt: z.iso.datetime().optional(),
  applicability: z.record(
    key,
    z
      .object({
        state: z.enum(['current', 'needs-review', 'archived']),
        checkedAt: z.iso.datetime(),
        reason: z.string().max(500),
      })
      .strict(),
  ),
  conflicts: z.array(key).max(2000),
  feedback: z.object({ used: revision, irrelevant: revision, outdated: revision, incorrect: revision }).strict(),
}).strict();
export type Learning = z.infer<typeof LearningSchema>;
export type LearningDraft = z.infer<typeof LearningDraftSchema>;
export const LearningOperationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('list'),
      search: z.string().max(200).default(''),
      state: z.enum(['all', 'proposed', 'accepted', 'needs-review', 'rejected', 'superseded']).default('all'),
      offset: revision.default(0),
    })
    .strict(),
  z.object({ action: z.literal('get'), id: key }).strict(),
  z
    .object({
      action: z.literal('save'),
      draft: LearningDraftSchema,
      id: key.optional(),
      expectedRevision: revision,
      idempotencyKey: key,
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      id: key,
      expectedRevision: revision,
      decision: z.enum(['accept', 'reject', 'promote']),
      idempotencyKey: key,
    })
    .strict(),
  z.object({ action: z.literal('delete'), id: key, expectedRevision: revision, idempotencyKey: key }).strict(),
  z.object({ action: z.literal('forget'), expectedRevision: revision, idempotencyKey: key }).strict(),
  z.object({ action: z.literal('export') }).strict(),
]);
export type LearningOperation = z.infer<typeof LearningOperationSchema>;
export const LearningResultSchema = z
  .object({
    memoryRevision: revision,
    records: z.array(LearningSchema).max(2000),
    total: revision,
    history: z.array(LearningSchema).max(100000).optional(),
    duplicate: z.boolean().optional(),
  })
  .strict();
export type LearningResult = z.infer<typeof LearningResultSchema>;
export const MemoryAuthoritySchema = z
  .object({
    projectId: key,
    checkoutId: key,
    root: z.string().min(1).max(32768),
    projectRoot: z.string().min(1).max(32768),
    archived: z.boolean().optional(),
    checkouts: z.array(z.object({ checkoutId: key, root: z.string().min(1).max(32768) }).strict()).max(1000),
    excludedPaths: z.array(z.string().max(4096)).max(200),
    origin: LearningSchema.shape.origin,
  })
  .strict();
export type MemoryAuthority = z.infer<typeof MemoryAuthoritySchema>;
