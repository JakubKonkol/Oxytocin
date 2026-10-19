import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { GrammarManifestSchema } from './code-map-grammar-manifest';

/** Copy only pinned, hash-verified WASM; grammar native bindings are never loaded. */
export async function copyCodeMapAssets(destination: string, root = resolve(import.meta.dirname, '..')): Promise<void> {
  const manifest = GrammarManifestSchema.parse(
    JSON.parse(await readFile(join(root, 'resources/code-map/grammars.json'), 'utf8')),
  );
  await mkdir(join(destination, 'grammars'), { recursive: true });
  for (const entry of [manifest.runtime, ...manifest.grammars]) {
    const packageRoot = join(root, 'node_modules', entry.package);
    const pkg = z
      .object({ version: z.string(), license: z.string() })
      .parse(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
    if (pkg.version !== entry.version || pkg.license !== entry.license)
      throw new Error(`Grammar metadata mismatch: ${entry.package}`);
    const source = join(packageRoot, entry.file);
    const hash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    if (hash !== entry.sha256) throw new Error(`Grammar integrity mismatch: ${entry.file}`);
    await copyFile(source, join(destination, entry === manifest.runtime ? '' : 'grammars', entry.file));
  }
  await copyFile(join(root, 'resources/code-map/grammars.json'), join(destination, 'grammars.json'));
}

if (process.argv[1]?.endsWith('code-map-assets.ts')) {
  void copyCodeMapAssets(resolve(process.argv[2] ?? 'out/code-map')).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
