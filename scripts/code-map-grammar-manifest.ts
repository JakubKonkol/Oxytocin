import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const GrammarManifestSchema = z.object({
  runtime: z.object({
    package: z.literal('web-tree-sitter'),
    version: z.string(),
    file: z.literal('web-tree-sitter.wasm'),
    sha256: hash,
    license: z.literal('MIT'),
  }),
  grammars: z.array(
    z.object({
      language: z.string(),
      package: z.string().regex(/^tree-sitter-[a-z-]+$/),
      version: z.string(),
      file: z.string().regex(/^tree-sitter-[a-z_-]+\.wasm$/),
      sha256: hash,
      license: z.literal('MIT'),
    }),
  ),
});
