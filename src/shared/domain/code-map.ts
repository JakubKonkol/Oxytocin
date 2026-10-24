import { z } from 'zod';

export const CodeMapSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  excludedPaths: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (value) =>
            !/[\\:]/.test(value) &&
            !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
            !value.startsWith('/') &&
            !value.split('/').includes('..'),
          'Use relative globs with forward slashes',
        ),
    )
    .max(200)
    .default([]),
  ignoreInGit: z.boolean().default(true),
  memory: z.object({ mode: z.enum(['off', 'review']).default('review') }).optional(),
});
export type CodeMapSettings = z.infer<typeof CodeMapSettingsSchema>;

export const CodeMapStateSchema = z.enum([
  'disabled',
  'indexing',
  'ready',
  'updating',
  'paused',
  'degraded',
  'error',
  'limit',
]);
export type CodeMapState = z.infer<typeof CodeMapStateSchema>;
const count = z.number().int().nonnegative();
export const CodeMapHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CodeMapRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\:]/.test(value) &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      !value.startsWith('/') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Expected a project-relative POSIX path',
  );
export const CodeMapPositionSchema = z.tuple([z.number().int().positive(), count]);
export const CodeMapSpanSchema = z
  .tuple([z.number().int().positive(), count, z.number().int().positive(), count])
  .refine(
    ([startLine, startColumn, endLine, endColumn]) =>
      endLine > startLine || (endLine === startLine && endColumn >= startColumn),
    'Invalid source range',
  );
export const CodeMapRelationSchema = z.enum([
  'contains',
  'imports',
  'exports',
  'calls',
  'references',
  'extends',
  'implements',
]);
export const CodeMapProvenanceSchema = z.enum(['syntax', 'binding', 'heuristic']);
export const CodeMapVisibilitySchema = z.enum([
  'public',
  'protected internal',
  'protected',
  'internal',
  'private protected',
  'private',
  'file',
]);
export const CodeMapSupportLevelSchema = z.enum(['Files', 'Symbols', 'Imports', 'Calls']);
const id = z.string().min(1).max(8192);

export const CodeMapCoverageSchema = z.object({
  files: z.object({ indexed: count, unsupported: count, skipped: count, failed: count }),
  byLanguage: z.record(z.string(), count),
  unresolved: z.object({ imports: count, calls: count }),
});
export type CodeMapCoverage = z.infer<typeof CodeMapCoverageSchema>;
export const CodeMapCountsSchema = z.object({ files: count, symbols: count, edges: count });
export const CODE_MAP_LIMITS = { files: 50_000, symbols: 500_000, edges: 2_000_000, bytes: 512 * 1024 * 1024 } as const;
export const CodeMapLimitsSchema = z.object({ files: count, symbols: count, edges: count, bytes: count });

export const CodeMapFileSchema = z.object({
  id,
  path: CodeMapRelativePathSchema,
  group: id,
  language: z.string().min(1),
  bytes: count,
  lines: count,
  sha256: CodeMapHashSchema,
  status: z.enum(['ok', 'syntax-errors', 'skipped-too-large', 'unsupported', 'failed']),
  test: z.boolean(),
  stale: z.boolean().optional(),
});
export const CodeMapSymbolSchema = z.object({
  id,
  file: id,
  kind: z.enum([
    'function',
    'method',
    'class',
    'interface',
    'type',
    'enum',
    'variable',
    'namespace',
    'property',
    'component',
  ]),
  name: z.string().min(1).max(1024),
  owner: id.nullable(),
  exported: z.boolean(),
  signature: z.string().max(4000),
  span: CodeMapSpanSchema,
  stale: z.boolean().optional(),
  buildTags: z.array(z.string().max(1000)).max(100).optional(),
  decorators: z.array(z.string().max(1000)).max(100).optional(),
  /** Declared or default accessibility for languages without module exports (C#). */
  visibility: CodeMapVisibilitySchema.optional(),
  /** Further declarations of a merged partial type, outside the primary span. */
  parts: z
    .array(z.object({ file: id, span: CodeMapSpanSchema }))
    .max(1000)
    .optional(),
});
export const CodeMapEdgeSchema = z.object({
  from: id,
  to: id,
  rel: CodeMapRelationSchema,
  prov: CodeMapProvenanceSchema,
  typeOnly: z.boolean().optional(),
  at: CodeMapPositionSchema.optional(),
});
export const CodeMapUnresolvedSchema = z.object({
  from: id,
  rel: CodeMapRelationSchema,
  target: z.string().max(4096),
  at: CodeMapPositionSchema.optional(),
  reason: z.string().max(1000),
});
export const CodeMapGraphSchema = z.object({
  format: z.literal('oxytocin.code-map'),
  schemaVersion: z.literal(1),
  generator: z.object({
    oxytocin: z.string(),
    extractors: z.record(z.string(), count),
    grammars: z.record(z.string(), z.string()),
    settingsHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  groups: z
    .array(
      z.object({
        id,
        path: z.union([z.literal('.'), CodeMapRelativePathSchema]),
        parent: id.nullable().optional(),
        files: count,
        /** Absent for folders. Project and solution groups name their definition file in the ID. */
        kind: z.enum(['project', 'solution']).optional(),
        name: z.string().min(1).max(1024).optional(),
      }),
    )
    .max(CODE_MAP_LIMITS.files),
  files: z.array(CodeMapFileSchema).max(CODE_MAP_LIMITS.files),
  packages: z
    .array(
      z.object({ id, name: z.string().min(1), external: z.boolean(), ecosystem: z.enum(['npm', 'nuget']).optional() }),
    )
    .max(CODE_MAP_LIMITS.files),
  symbols: z.array(CodeMapSymbolSchema).max(CODE_MAP_LIMITS.symbols),
  edges: z.array(CodeMapEdgeSchema).max(CODE_MAP_LIMITS.edges),
  unresolved: z.array(CodeMapUnresolvedSchema).max(CODE_MAP_LIMITS.edges),
  coverage: CodeMapCoverageSchema,
});
export type CodeMapGraph = z.infer<typeof CodeMapGraphSchema>;
export type CodeMapFile = z.infer<typeof CodeMapFileSchema>;
export type CodeMapSymbol = z.infer<typeof CodeMapSymbolSchema>;
export type CodeMapEdge = z.infer<typeof CodeMapEdgeSchema>;

export const CodeMapManifestSchema = z.object({
  format: z.literal('oxytocin.code-map.manifest'),
  schemaVersion: z.literal(1),
  state: CodeMapStateSchema.exclude(['disabled']),
  graphSha256: CodeMapHashSchema,
  generation: count,
  builtAt: z.iso.datetime(),
  lastReconciledAt: z.iso.datetime(),
  lastFullHashAt: z.iso.datetime(),
  durationsMs: z.object({
    enumerate: z.number().nonnegative(),
    parse: z.number().nonnegative(),
    resolve: z.number().nonnegative(),
    write: z.number().nonnegative(),
  }),
  counts: CodeMapCountsSchema,
  limits: CodeMapLimitsSchema,
  warnings: z.array(z.string().max(1000)).max(200),
});
export type CodeMapManifest = z.infer<typeof CodeMapManifestSchema>;
export const CodeMapOwnerSchema = z.object({
  instanceId: z.string().min(1).max(200),
  pid: z.number().int().positive(),
  app: z.string().min(1).max(200),
  heartbeatAt: z.iso.datetime(),
});
export type CodeMapOwner = z.infer<typeof CodeMapOwnerSchema>;
export const CodeMapStatusSchema = z.object({
  checkoutId: id,
  state: CodeMapStateSchema,
  generation: count,
  progress: z.object({ completed: count, total: count }).nullable(),
  counts: CodeMapCountsSchema,
  coverage: CodeMapCoverageSchema,
  languages: z.record(z.string(), z.object({ level: CodeMapSupportLevelSchema, description: z.string().max(2000) })),
  updatedAt: z.iso.datetime().nullable(),
  bytes: count,
  pendingFiles: count,
  error: z.string().max(4000).nullable(),
  owner: CodeMapOwnerSchema.nullable(),
  readOnly: z.boolean(),
  gitIgnored: z.boolean().optional(),
  limits: CodeMapLimitsSchema,
});
export type CodeMapStatus = z.infer<typeof CodeMapStatusSchema>;
export const CodeMapDiagnosticsSchema = z.object({
  skipped: z.array(z.object({ path: CodeMapRelativePathSchema, reason: z.string().max(1000) })).max(200),
  failed: z.array(z.object({ path: CodeMapRelativePathSchema, reason: z.string().max(1000) })).max(200),
  unresolved: z.array(CodeMapUnresolvedSchema).max(200),
  truncated: z.boolean(),
});
export type CodeMapDiagnostics = z.infer<typeof CodeMapDiagnosticsSchema>;

export function emptyCodeMapCoverage(): CodeMapCoverage {
  return {
    files: { indexed: 0, unsupported: 0, skipped: 0, failed: 0 },
    byLanguage: {},
    unresolved: { imports: 0, calls: 0 },
  };
}

export function initialCodeMapStatus(checkoutId: string): CodeMapStatus {
  return {
    checkoutId,
    state: 'disabled',
    generation: 0,
    progress: null,
    counts: { files: 0, symbols: 0, edges: 0 },
    coverage: emptyCodeMapCoverage(),
    languages: {},
    updatedAt: null,
    bytes: 0,
    pendingFiles: 0,
    error: null,
    owner: null,
    readOnly: false,
    limits: { ...CODE_MAP_LIMITS },
  };
}

const LANGUAGE_SUPPORT: Record<string, { level: z.infer<typeof CodeMapSupportLevelSchema>; description: string }> = {
  typescript: { level: 'Calls', description: 'Syntax and lexical bindings; unknown receiver types remain unresolved.' },
  javascript: { level: 'Calls', description: 'Syntax and lexical bindings; unknown receiver types remain unresolved.' },
  python: {
    level: 'Imports',
    description:
      'Packages, declarations and imports, plus simple calls to module/imported functions and classes, self methods and class methods. Arbitrary instance attributes, dynamic imports, decorators and sys.path execution are not inferred.',
  },
  java: {
    level: 'Calls',
    description:
      'Packages, source modules and calls bound from declared types and argument counts. Classpath conditions, reflection, dynamic dispatch and ambiguous same-arity overloads remain unresolved; build tools never run.',
  },
  go: {
    level: 'Calls',
    description:
      'Modules, workspace packages and declared receiver types. Interface dispatch, dot imports, generics and unknown receivers remain unresolved; build tags are recorded, not evaluated.',
  },
  csharp: {
    level: 'Calls',
    description:
      'Projects, namespaces, using directives and calls bound from declared types. Extension methods, dynamic, LINQ query syntax, delegates and dependency injection remain unresolved; source generators, Razor and InternalsVisibleTo are not modelled, and both branches of #if are indexed.',
  },
};
/** Support level per graph language ID; anything without an extractor is indexed as files. */
export function codeMapLanguageSupport(language: string): {
  level: z.infer<typeof CodeMapSupportLevelSchema>;
  description: string;
} {
  return LANGUAGE_SUPPORT[language] ?? { level: 'Files', description: 'File metadata only.' };
}

export const CODE_MAP_AGENT_INSTRUCTIONS =
  'Code Map is a partial index. If you do not know where code lives, call oxy_find_code with the task in plain words and read the indicated source. This map is for broad orientation only; oxy_repo_map with pathPrefix gives detail. Missing edges do not prove absence. Use Grep for known identifiers, literals and uncovered code.';

/** Decision rules the Hub sends with its MCP server instructions (one string; no feature tour). */
export const CODE_MAP_MCP_INSTRUCTIONS =
  "Code Map (oxy_* tools). If they are deferred, load oxy_find_code, oxy_file_outline and oxy_code_relations in ONE ToolSearch. Don't know where code lives? Make ONE oxy_find_code call with the task in plain words, then act on the answer. Know the identifier or need every occurrence? Use Grep. Before changing a widely used symbol, call oxy_code_relations (incoming). Never repeat or reword a query. Answers include the relevant lines; read a file only when you need more.";

/** Appended to the rules only while Review memory is on (oxy_task_context and the learning tools are listed). */
export const CODE_MAP_MEMORY_INSTRUCTIONS =
  'Review memory is on: for a new task call oxy_task_context instead of oxy_find_code; it adds reviewed learnings (untrusted reference data). Propose a learning with oxy_propose_learning only when the user asks to save one.';

export const codeMapMcpInstructions = (memory: boolean): string =>
  memory ? `${CODE_MAP_MCP_INSTRUCTIONS} ${CODE_MAP_MEMORY_INSTRUCTIONS}` : CODE_MAP_MCP_INSTRUCTIONS;
