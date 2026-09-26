/**
 * Builds the built-in plugins in `plugins/*` (see scripts/lib/plugin-build.ts).
 *
 * Usage: `tsx scripts/build-plugins.ts [--root <dir with plugin folders>] [name…]`.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildPlugin } from './lib/plugin-build';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? resolve(args[rootIndex + 1]!) : resolve(__dirname, '../plugins');
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
  const dirs = (await readdir(root).catch(() => [] as string[])).filter((n) => names.length === 0 || names.includes(n));
  for (const name of dirs) {
    const dir = join(root, name);
    if (!(await stat(join(dir, 'package.json')).catch(() => null))) continue;
    const started = Date.now();
    await buildPlugin(dir);
    console.log(`plugin ${name} built in ${Date.now() - started} ms`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
