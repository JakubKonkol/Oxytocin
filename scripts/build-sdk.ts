/**
 * Bundles the plugin view SDK (`packages/plugin-sdk/dist`). With `--copy <dir>…` the bundle is also copied as
 * `oxy-sdk.js` into fixture plugins used by the E2E tests.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(__dirname, '..');
const pkg = join(root, 'packages/plugin-sdk');

async function main(): Promise<void> {
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await build({
    entryPoints: [join(pkg, 'src/index.ts')],
    outfile: join(pkg, 'dist/index.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    legalComments: 'inline',
    logLevel: 'warning',
  });
  await build({
    entryPoints: [join(pkg, 'src/react.ts')],
    outfile: join(pkg, 'dist/react.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    external: ['react'],
    logLevel: 'warning',
  });
  await copyFile(join(pkg, 'src/theme.css'), join(pkg, 'dist/theme.css'));
  const copyIndex = process.argv.indexOf('--copy');
  if (copyIndex >= 0) {
    for (const dir of process.argv.slice(copyIndex + 1)) {
      await copyFile(join(pkg, 'dist/index.js'), join(resolve(root, dir), 'oxy-sdk.js'));
      await copyFile(join(pkg, 'src/theme.css'), join(resolve(root, dir), 'oxy-theme.css'));
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
