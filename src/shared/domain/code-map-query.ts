import { z } from 'zod';
import {
  CodeMapCoverageSchema,
  CodeMapEdgeSchema,
  CodeMapFileSchema,
  CodeMapGraphSchema,
  CodeMapRelativePathSchema,
  CodeMapRelationSchema,
  CodeMapStateSchema,
  CodeMapStatusSchema,
  CodeMapSymbolSchema,
} from './code-map';

export const CodeMapFreshnessModeSchema = z.enum(['latest', 'allow-stale', 'verified']);
const options = {
  freshness: CodeMapFreshnessModeSchema.default('latest'),
  maxChars: z.number().int().min(2000).max(24000).default(8000),
};
const pathPrefix = CodeMapRelativePathSchema.optional();
export const CodeMapQuerySchemas = {
  status: z.object({ ...options }).strict(),
  'repo-map': z.object({ ...options, pathPrefix }).strict(),
  search: z
    .object({
      ...options,
      pathPrefix,
      query: z.string().trim().min(1).max(2000),
      limit: z.number().int().min(1).max(50).default(8),
    })
    .strict(),
  outline: z.object({ ...options, path: CodeMapRelativePathSchema }).strict(),
  relations: z
    .object({
      ...options,
      path: CodeMapRelativePathSchema.optional(),
      symbolId: z.string().min(1).max(8192).optional(),
      /** With `path`: the symbol declared at or around this 1-based line (the innermost one) instead of the file. */
      line: z.number().int().min(1).max(10_000_000).optional(),
      direction: z.enum(['incoming', 'outgoing', 'both']).default('both'),
      relations: z
        .array(CodeMapRelationSchema)
        .min(1)
        .max(7)
        .default(['imports', 'exports', 'calls', 'references', 'extends', 'implements']),
      depth: z.number().int().min(1).max(3).default(1),
      includeHeuristic: z.boolean().default(false),
    })
    .strict()
    .refine((v) => Boolean(v.path) !== Boolean(v.symbolId), 'Pass exactly one of path or symbolId')
    .refine((v) => v.line === undefined || Boolean(v.path), 'line requires path'),
} as const;
export const CodeMapQuerySchema = z.discriminatedUnion('kind', [
  CodeMapQuerySchemas.status.extend({ kind: z.literal('status') }),
  CodeMapQuerySchemas['repo-map'].extend({ kind: z.literal('repo-map') }),
  CodeMapQuerySchemas.search.extend({ kind: z.literal('search') }),
  CodeMapQuerySchemas.outline.extend({ kind: z.literal('outline') }),
  CodeMapQuerySchemas.relations.safeExtend({ kind: z.literal('relations') }),
]);
export type CodeMapQuery = z.infer<typeof CodeMapQuerySchema>;
export type CodeMapQueryInput = z.input<typeof CodeMapQuerySchema>;

export const CodeMapFreshnessSchema = z.object({
  generation: z.number().int().nonnegative(),
  state: CodeMapStateSchema,
  stale: z.boolean(),
  verification: z.enum(['metadata', 'content-hash']),
  checkedAt: z.iso.datetime().nullable(),
  lastFullHashAt: z.iso.datetime().nullable(),
  pendingFiles: z.number().int().nonnegative(),
  coverage: CodeMapCoverageSchema,
  warnings: z.array(z.string().max(1000)).max(20),
});
const node = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), value: CodeMapFileSchema, whyIncluded: z.string().max(200) }),
  z.object({ kind: z.literal('symbol'), value: CodeMapSymbolSchema, whyIncluded: z.string().max(200) }),
  z.object({
    kind: z.literal('group'),
    value: CodeMapGraphSchema.shape.groups.element,
    whyIncluded: z.string().max(200),
  }),
  z.object({
    kind: z.literal('package'),
    value: CodeMapGraphSchema.shape.packages.element,
    whyIncluded: z.string().max(200),
  }),
]);
export const CodeMapQueryDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), status: CodeMapStatusSchema.omit({ owner: true, error: true }) }),
  z.object({ kind: z.literal('repo-map'), markdown: z.string().max(24000) }),
  z.object({
    kind: z.literal('search'),
    /** Idf-weighted share of the question matched by the top hit (0-1); absent when the ranking does not report it. */
    coverage: z.number().min(0).max(1).optional(),
    /** The top hit matched in a symbol name; absent when the ranking does not report it. */
    strong: z.boolean().optional(),
    matches: z
      .array(
        z.object({
          id: z.string(),
          path: CodeMapRelativePathSchema,
          name: z.string(),
          kind: z.string(),
          signature: z.string().optional(),
          span: CodeMapSymbolSchema.shape.span.optional(),
          stale: z.boolean(),
          score: z.number(),
          whyIncluded: z.array(z.string()),
        }),
      )
      .max(50),
    /** Idf-weighted share (0-1) of the question's terms matched by the best result. */
    coverage: z.number().min(0).max(1).optional(),
    /** The best result matched the question in its own name, or is an exact identifier or path match. */
    strong: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('outline'),
    file: CodeMapFileSchema,
    definitions: z.array(CodeMapSymbolSchema),
    imports: z.array(CodeMapEdgeSchema),
  }),
  z.object({
    kind: z.literal('relations'),
    nodes: z.array(node).max(2000),
    edges: z.array(CodeMapEdgeSchema.extend({ whyIncluded: z.string().max(200) })).max(5000),
    visitedNodes: z.number().int().nonnegative(),
    visitedEdges: z.number().int().nonnegative(),
    exhaustive: z.literal(false),
  }),
]);
export const CodeMapQueryResultSchema = z.object({
  checkoutId: z.string().min(1).max(200),
  code: z.enum(['OK', 'INDEX_UPDATING', 'INDEX_PAUSED', 'INDEX_UNAVAILABLE', 'NOT_FOUND', 'BUDGET']),
  freshness: CodeMapFreshnessSchema,
  data: CodeMapQueryDataSchema.optional(),
  truncated: z.boolean(),
  reasons: z.array(z.enum(['CHAR_BUDGET', 'VISIT_LIMIT', 'RESULT_LIMIT', 'MAP_BUDGET'])).max(4),
  hint: z.string().max(500),
});
export type CodeMapQueryResult = z.infer<typeof CodeMapQueryResultSchema>;
export type CodeMapQueryData = z.infer<typeof CodeMapQueryDataSchema>;
