import { z } from 'zod';
import {
  CodeMapFileSchema,
  CodeMapPositionSchema,
  CodeMapRelativePathSchema,
  CodeMapSymbolSchema,
} from '@shared/domain/code-map';

export const EXTRACTOR_VERSION = 1;
export const ImportIntentSchema = z.object({
  module: z.string().max(4096).nullable(),
  scope: z.string(),
  at: CodeMapPositionSchema,
  typeOnly: z.boolean(),
  kind: z.enum(['import', 'export', 'dynamic', 'require']),
});
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
      }),
    )
    .max(100_000),
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
