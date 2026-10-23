import { z } from 'zod';
import {
  CodeMapFileSchema,
  CodeMapPositionSchema,
  CodeMapRelativePathSchema,
  CodeMapSymbolSchema,
} from '@shared/domain/code-map';

/** Bump on every change of extracted records: cached records of another version are reparsed. */
export const EXTRACTOR_VERSION = 7;
export const PythonRecordSchema = z.object({
  module: z.string(),
  all: z.array(z.string().max(1024)).max(50_000).nullable().optional(),
  imports: z
    .array(
      z.object({
        module: z.string().max(4096),
        level: z.number().int().nonnegative().max(100),
        scope: z.string(),
        names: z.array(z.object({ name: z.string(), alias: z.string() })).max(1000),
        from: z.boolean(),
        wildcard: z.boolean(),
        at: CodeMapPositionSchema,
      }),
    )
    .max(50_000),
  definitions: z
    .array(
      z.object({
        symbol: z.string(),
        name: z.string(),
        scope: z.string(),
        kind: z.enum(['function', 'class', 'variable']),
        ownerClass: z.string().nullable(),
      }),
    )
    .max(50_000),
  bindings: z
    .array(
      z.object({
        scope: z.string(),
        name: z.string(),
        kind: z.enum(['definition', 'import', 'unknown', 'self']),
        symbol: z.string().optional(),
        module: z.string().optional(),
        imported: z.string().nullable().optional(),
        level: z.number().int().nonnegative().max(100).optional(),
      }),
    )
    .max(100_000),
  bases: z
    .array(
      z.object({
        symbol: z.string(),
        scope: z.string(),
        target: z.array(z.string()).max(20).nullable(),
        at: CodeMapPositionSchema,
      }),
    )
    .max(50_000),
  calls: z
    .array(
      z.object({
        from: z.string(),
        scope: z.string(),
        ownerClass: z.string().nullable(),
        target: z.array(z.string()).max(20).nullable(),
        at: CodeMapPositionSchema,
      }),
    )
    .max(100_000),
});
export type PythonRecord = z.infer<typeof PythonRecordSchema>;
export const JavaRecordSchema = z.object({
  package: z.string().max(4096),
  imports: z
    .array(
      z.object({ name: z.string().max(4096), wildcard: z.boolean(), static: z.boolean(), at: CodeMapPositionSchema }),
    )
    .max(50_000),
  types: z
    .array(
      z.object({
        symbol: z.string(),
        name: z.string(),
        full: z.string(),
        outer: z.string().nullable(),
        bases: z
          .array(z.object({ name: z.string(), rel: z.enum(['extends', 'implements']), at: CodeMapPositionSchema }))
          .max(100),
      }),
    )
    .max(50_000),
  members: z
    .array(
      z.object({
        symbol: z.string(),
        owner: z.string(),
        name: z.string(),
        type: z.string().nullable(),
        static: z.boolean(),
        constructor: z.boolean(),
        parameters: z.number().int().nonnegative().nullable(),
        variadic: z.boolean(),
      }),
    )
    .max(50_000),
  locals: z.array(z.object({ scope: z.string(), name: z.string(), type: z.string().nullable() })).max(100_000),
  calls: z
    .array(
      z.object({
        from: z.string(),
        scope: z.string(),
        owner: z.string().nullable(),
        receiver: z.string().nullable(),
        target: z.string(),
        constructor: z.boolean(),
        args: z.number().int().nonnegative(),
        at: CodeMapPositionSchema,
      }),
    )
    .max(100_000),
  references: z
    .array(z.object({ from: z.string(), owner: z.string().nullable(), name: z.string(), at: CodeMapPositionSchema }))
    .max(100_000),
});
export type JavaRecord = z.infer<typeof JavaRecordSchema>;
export const GoRecordSchema = z.object({
  package: z.string().max(1024),
  buildTags: z.array(z.string().max(1000)).max(100),
  imports: z
    .array(
      z.object({ module: z.string().max(4096), alias: z.string().max(1024).nullable(), at: CodeMapPositionSchema }),
    )
    .max(50_000),
  declarations: z
    .array(
      z.object({
        symbol: z.string(),
        name: z.string(),
        scope: z.string(),
        receiver: z.string().optional(),
        typeKind: z.enum(['struct', 'interface', 'alias', 'type']).optional(),
        target: z.string().optional(),
        parameters: z.number().int().nonnegative().optional(),
      }),
    )
    .max(50_000),
  locals: z.array(z.object({ scope: z.string(), name: z.string(), type: z.string().nullable() })).max(100_000),
  calls: z
    .array(
      z.object({
        from: z.string(),
        scope: z.string(),
        target: z.array(z.string()).max(20).nullable(),
        args: z.number().int().nonnegative(),
        at: CodeMapPositionSchema,
      }),
    )
    .max(100_000),
});
export type GoRecord = z.infer<typeof GoRecordSchema>;
/** A dotted C# name: each segment is `Name` or `Name/arity` for generic names. */
const CSharpNameSchema = z.array(z.string().min(1).max(1024)).min(1).max(32);
export const CSharpTypeRefSchema = z.object({ name: CSharpNameSchema, scope: z.string() });
const CSharpReceiverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('this') }),
  z.object({ kind: z.literal('base') }),
  z.object({ kind: z.literal('name'), name: CSharpNameSchema }),
  z.object({ kind: z.literal('new'), type: CSharpNameSchema }),
  z.object({ kind: z.literal('expression') }),
]);
const CSharpUsingsSchema = z.object({
  namespaces: z.array(z.string().max(4096)).max(1000),
  statics: z.array(CSharpNameSchema).max(1000),
  aliases: z.array(z.object({ name: z.string().max(1024), target: CSharpNameSchema })).max(1000),
});
export const CSharpRecordSchema = z.object({
  /** Lookup context per lexical scope ID; absent entries inherit everything from their parent. */
  contexts: z
    .array(
      z.object({
        scope: z.string(),
        namespace: z.string().max(4096).optional(),
        usings: CSharpUsingsSchema.optional(),
        typeParameters: z.array(z.string().max(1024)).max(100).optional(),
      }),
    )
    .max(100_000),
  globalUsings: CSharpUsingsSchema,
  types: z
    .array(
      z.object({
        symbol: z.string(),
        name: z.string().max(1024),
        arity: z.number().int().nonnegative(),
        /** Fully qualified namespace and enclosing type names, dotted. */
        container: z.string().max(8192),
        outer: z.string().nullable(),
        kind: z.enum(['class', 'struct', 'record', 'interface', 'enum', 'delegate']),
        partial: z.boolean(),
        scope: z.string(),
        bases: z.array(CSharpTypeRefSchema.extend({ at: CodeMapPositionSchema })).max(100),
      }),
    )
    .max(50_000),
  members: z
    .array(
      z.object({
        owner: z.string(),
        name: z.string().max(1024),
        symbol: z.string(),
        kind: z.enum(['method', 'constructor', 'property', 'field', 'event', 'indexer', 'operator', 'enum-member']),
        static: z.boolean(),
        parameters: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
        type: CSharpTypeRefSchema.nullable(),
      }),
    )
    .max(50_000),
  locals: z
    .array(
      z.object({
        scope: z.string(),
        name: z.string().max(1024),
        type: CSharpTypeRefSchema.nullable(),
        symbol: z.string().optional(),
        parameters: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
      }),
    )
    .max(100_000),
  relations: z
    .array(
      z.object({
        from: z.string(),
        scope: z.string(),
        rel: z.enum(['calls', 'references']),
        /** Calls: the invoked member name; references: the referenced type name. */
        target: CSharpNameSchema,
        receiver: CSharpReceiverSchema.optional(),
        args: z.number().int().nonnegative().optional(),
        syntax: z.enum(['call', 'new', 'type', 'attribute', 'nameof']),
        at: CodeMapPositionSchema,
      }),
    )
    .max(100_000),
  /** Top-level statements make the file a program entry point. */
  topLevel: z.boolean(),
});
export type CSharpRecord = z.infer<typeof CSharpRecordSchema>;
export type CSharpTypeRef = z.infer<typeof CSharpTypeRefSchema>;
export const ImportIntentSchema = z.object({
  module: z.string().max(4096).nullable(),
  scope: z.string(),
  at: CodeMapPositionSchema,
  typeOnly: z.boolean(),
  kind: z.enum(['import', 'export', 'dynamic', 'require']),
});
/**
 * A type written in the source, kept as syntax: resolution happens in the graph build, against indexed declarations.
 * `name` is a (qualified) type reference, `promise` marks `Promise<name>`, `wrappers` lists member-preserving utility
 * types around it (`Pick<name, ...>`); `call` is the type returned by calling the
 * named callee (`await` unwraps `Promise`); `value` is the type of the value at a name or member path
 * (`const x = this.deps`, `const { a } = this.deps`); `shape` marks an anonymous object type whose members are owned by the
 * declaring property symbol. Unions with `null`/`undefined` collapse to the remaining member; anything else
 * (other unions, intersections, arrays, function types, `any`) is not recorded.
 */
export const TypeRefSchema = z.union([
  z
    .object({
      name: z.array(z.string().max(1024)).min(1).max(20),
      promise: z.literal(true).optional(),
      wrappers: z.array(z.string().max(32)).min(1).max(8).optional(),
    })
    .strict(),
  z.object({ call: z.array(z.string().max(1024)).min(1).max(20), await: z.literal(true).optional() }).strict(),
  z.object({ value: z.array(z.string().max(1024)).min(1).max(20) }).strict(),
  z.object({ shape: z.literal(true) }).strict(),
]);
export type TypeRef = z.infer<typeof TypeRefSchema>;
export const FileRecordSchema = z.object({
  version: z.literal(EXTRACTOR_VERSION),
  file: CodeMapFileSchema,
  symbols: z.array(CodeMapSymbolSchema).max(50_000),
  scopes: z
    .array(
      z.object({
        id: z.string(),
        parent: z.string().nullable(),
        kind: z.enum(['file', 'function', 'class', 'block', 'namespace']),
        thisClass: z.string().nullable(),
        staticThis: z.boolean(),
      }),
    )
    .max(100_000),
  bindings: z
    .array(
      z.object({
        name: z.string(),
        scope: z.string(),
        symbol: z.string().nullable(),
        imported: z
          .object({ module: z.string(), name: z.string(), typeOnly: z.boolean(), require: z.boolean().optional() })
          .optional(),
        implementation: z.boolean().optional(),
        /** Declared or `new`-initialized type of a parameter or variable, resolved in `scope`. */
        type: TypeRefSchema.optional(),
      }),
    )
    .max(100_000),
  /**
   * Declared types of symbols: properties and exported variables (their type), functions and methods (their return
   * type), type aliases (the aliased type). Names resolve in `scope`. Overloaded or merged declarations are omitted.
   */
  symbolTypes: z
    .array(z.object({ symbol: z.string(), scope: z.string(), type: TypeRefSchema }))
    .max(50_000)
    .optional(),
  members: z
    .array(
      z.object({
        owner: z.string(),
        name: z.string(),
        symbol: z.string(),
        static: z.boolean(),
        implementation: z.boolean().optional(),
      }),
    )
    .max(50_000),
  imports: z.array(ImportIntentSchema).max(50_000),
  exports: z
    .array(
      z.object({
        name: z.string(),
        local: z.string().optional(),
        symbol: z.string().optional(),
        module: z.string().optional(),
        imported: z.string().optional(),
        typeOnly: z.boolean(),
      }),
    )
    .max(50_000),
  relations: z
    .array(
      z.object({
        from: z.string(),
        scope: z.string(),
        target: z.array(z.string()).max(20).nullable(),
        rel: z.enum(['calls', 'references', 'extends', 'implements']),
        at: CodeMapPositionSchema,
        syntax: z.enum(['call', 'new', 'jsx', 'type', 'value']),
      }),
    )
    .max(100_000),
  syntaxErrors: z.number().int().nonnegative(),
  csharp: CSharpRecordSchema.optional(),
  go: GoRecordSchema.optional(),
  java: JavaRecordSchema.optional(),
  python: PythonRecordSchema.optional(),
});
export type FileRecord = z.infer<typeof FileRecordSchema>;
export type Scope = FileRecord['scopes'][number];
export type RelationIntent = FileRecord['relations'][number];
export const ParseJobSchema = z
  .object({ id: z.number().int().positive(), path: CodeMapRelativePathSchema, source: z.string().max(2 * 1024 * 1024) })
  .strict();
export const ParseResultSchema = z.union([
  z.object({ id: z.number().int().positive(), record: FileRecordSchema }).strict(),
  z
    .object({
      id: z.number().int().positive(),
      error: z.string().max(4000),
      code: z.enum(['LIMIT', 'PARSE']).default('PARSE'),
    })
    .strict(),
]);
