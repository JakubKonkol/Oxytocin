import { z } from 'zod';
import {
  CodeMapRelativePathSchema,
  CodeMapRelationSchema,
  CodeMapSpanSchema,
  CodeMapStateSchema,
  CodeMapHashSchema,
} from './code-map';
import {
  type CodeMapFreshnessSchema,
  CodeMapFreshnessModeSchema,
  CodeMapQueryResultSchema,
  CodeMapQuerySchema,
  CodeMapQuerySchemas,
  CodeMapQueryDataSchema,
} from './code-map-query';

export const CodeMapRefSchema = z
  .object({ projectId: z.string().min(1).max(64), checkoutId: z.string().min(1).max(200) })
  .strict();
export const CodeMapChangeSchema = CodeMapRefSchema.extend({
  generation: z.number().int().nonnegative(),
  state: CodeMapStateSchema,
});
export const CodeMapCheckoutInfoSchema = CodeMapRefSchema.extend({
  label: z.string().max(1000),
  mode: z.enum(['project', 'worktree']),
});
export const CodeMapSliceQuerySchema = z
  .object({
    kind: z.literal('slice'),
    view: z.enum(['overview', 'file', 'neighborhood']),
    root: z
      .union([
        z.object({ path: CodeMapRelativePathSchema }).strict(),
        z.object({ symbolId: z.string().min(1).max(8192) }).strict(),
      ])
      .optional(),
    generation: z.number().int().nonnegative().optional(),
    pathPrefix: CodeMapRelativePathSchema.optional(),
    direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
    relations: z
      .array(CodeMapRelationSchema)
      .min(1)
      .max(7)
      .default(['imports', 'references', 'calls', 'exports', 'extends', 'implements']),
    depth: z.number().int().min(1).max(3).default(1),
    includeHeuristic: z.boolean().default(false),
    maxNodes: z.number().int().min(1).max(500).default(150),
    maxEdges: z.number().int().min(1).max(1000).default(300),
    freshness: CodeMapFreshnessModeSchema.default('latest'),
  })
  .strict()
  .refine((v) => v.view === 'overview' || !!v.root, 'File and neighborhood slices need a root');
export type CodeMapSliceQuery = z.infer<typeof CodeMapSliceQuerySchema>;
const ref = CodeMapRefSchema.shape;
export const CodeMapPluginRequestSchema = z.discriminatedUnion('kind', [
  CodeMapQuerySchemas.search.extend({ ...ref, kind: z.literal('search') }),
  CodeMapQuerySchemas.outline.extend({ ...ref, kind: z.literal('outline') }),
  CodeMapQuerySchemas.relations.safeExtend({ ...ref, kind: z.literal('relations') }),
  CodeMapSliceQuerySchema.safeExtend(ref),
]);
export type CodeMapPluginRequest = z.input<typeof CodeMapPluginRequestSchema>;
export const CodeMapHostQuerySchema = z.union([CodeMapQuerySchema, CodeMapSliceQuerySchema]);
export type CodeMapHostQueryInput = z.input<typeof CodeMapHostQuerySchema>;

export const CodeMapSliceNodeSchema = z.object({
  id: z.string().min(1).max(8192),
  kind: z.enum(['file', 'symbol', 'group', 'package']),
  label: z.string().max(4096),
  path: z.union([CodeMapRelativePathSchema, z.literal('.')]).optional(),
  files: z.number().int().nonnegative().optional(),
  symbolKind: z.string().optional(),
  signature: z.string().max(4000).optional(),
  span: CodeMapSpanSchema.optional(),
  sha256: CodeMapHashSchema.optional(),
  stale: z.boolean().optional(),
  whyIncluded: z.string().max(200),
});
export const CodeMapSliceEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  rel: CodeMapRelationSchema,
  prov: z.enum(['syntax', 'binding', 'heuristic']),
  count: z.number().int().positive().optional(),
  at: z.tuple([z.number().int().positive(), z.number().int().nonnegative()]).optional(),
  typeOnly: z.boolean().optional(),
  whyIncluded: z.string().max(200),
});
export const CodeMapSliceDataSchema = z.object({
  kind: z.literal('slice'),
  view: CodeMapSliceQuerySchema.shape.view,
  nodes: z.array(CodeMapSliceNodeSchema).max(500),
  edges: z.array(CodeMapSliceEdgeSchema).max(1000),
  visitedNodes: z.number().int().nonnegative(),
  visitedEdges: z.number().int().nonnegative(),
  exhaustive: z.literal(false),
});
export const CodeMapHostQueryResultSchema = CodeMapQueryResultSchema.extend({
  code: z.enum([...CodeMapQueryResultSchema.shape.code.options, 'SNAPSHOT_CHANGED']),
  data: z.union([CodeMapQueryDataSchema, CodeMapSliceDataSchema]).optional(),
  reasons: z
    .array(
      z.enum([...CodeMapQueryResultSchema.shape.reasons.element.options, 'NODE_LIMIT', 'EDGE_LIMIT', 'BYTE_BUDGET']),
    )
    .max(7),
});
export type CodeMapHostQueryResult = z.infer<typeof CodeMapHostQueryResultSchema>;
export type CodeMapSliceData = z.infer<typeof CodeMapSliceDataSchema>;
export const CodeMapLocatorSchema = CodeMapRefSchema.extend({
  path: CodeMapRelativePathSchema,
  generation: z.number().int().nonnegative(),
  sha256: CodeMapHashSchema,
  span: CodeMapSpanSchema.optional(),
  symbolId: z.string().min(1).max(8192).optional(),
});
export const CodeMapSourceLocationSchema = z.object({
  path: CodeMapRelativePathSchema,
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});
export const CodeMapPluginResultSchema = CodeMapHostQueryResultSchema;
export type CodeMapFreshness = z.infer<typeof CodeMapFreshnessSchema>;
