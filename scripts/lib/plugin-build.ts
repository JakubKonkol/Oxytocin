/**
 * Build of one plugin folder (docs/plan/07-plugin-engine.md §3, roadmap M5-T5):
 * - `src/host.ts` (or `src/host/index.ts`) → `dist/host.js` (ESM bundle for the Plugin Host, dependencies bundled),
 * - `src/views/*.html` → `dist/views/` (Vite, relative asset paths so they load from oxy-plugin://),
 * - `oxytocin-checksums.json` with SHA-256 of every shipped file (verified for packaged builds).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const repo = resolve(__dirname, '../..');
export const CHECKSUM_FILE = 'oxytocin-checksums.json';
const HOST_ENTRIES = ['src/host.ts', 'src/host/index.ts', 'src/host.js'];

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

/** Files that ship with a plugin (package.json, dist/, icons, README, LICENSE). */
export async function shippedFiles(pluginDir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(pluginDir)) {
    const full = join(pluginDir, name);
    if (name === 'dist') files.push(...(await listFiles(full)));
    else if (/^(package\.json|README\.md|LICENSE|icon\.(svg|png))$/.test(name)) files.push(full);
  }
  return files.sort();
}

export async function writeChecksums(pluginDir: string): Promise<Record<string, string>> {
  const sums: Record<string, string> = {};
  for (const file of await shippedFiles(pluginDir)) {
    const rel = relative(pluginDir, file).split(sep).join('/');
    sums[rel] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  }
  await writeFile(join(pluginDir, CHECKSUM_FILE), `${JSON.stringify(sums, null, 2)}\n`);
  return sums;
}

/** Whether sources (package.json, src/**) changed since the last build (its checksum file). */
export async function isStale(pluginDir: string): Promise<boolean> {
  const built = await stat(join(pluginDir, CHECKSUM_FILE)).catch(() => null);
  if (!built) return true;
  const sources = [join(pluginDir, 'package.json')];
  if (await exists(join(pluginDir, 'src'))) sources.push(...(await listFiles(join(pluginDir, 'src'))));
  for (const file of sources) if ((await stat(file)).mtimeMs > built.mtimeMs) return true;
  return false;
}

export async function buildPlugin(pluginDir: string): Promise<void> {
  const dist = join(pluginDir, 'dist');
  await rm(dist, { recursive: true, force: true });
  let hostEntry: string | undefined;
  for (const candidate of HOST_ENTRIES) {
    if (await exists(join(pluginDir, candidate))) {
      hostEntry = join(pluginDir, candidate);
      break;
    }
  }
  if (hostEntry) {
    await esbuild({
      entryPoints: [hostEntry],
      outfile: join(dist, 'host.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // CommonJS dependencies bundled into ESM need `require` for Node built-ins.
      banner: {
        js: "import { createRequire as __oxyRequire } from 'node:module'; const require = __oxyRequire(import.meta.url);",
      },
      legalComments: 'linked',
      logLevel: 'warning',
    });
  }
  const viewsDir = join(pluginDir, 'src/views');
  if (await exists(viewsDir)) {
    const pages = (await readdir(viewsDir)).filter((f) => f.endsWith('.html'));
    if (pages.length > 0) {
      await viteBuild({
        root: viewsDir,
        base: './',
        logLevel: 'warn',
        configFile: false,
        plugins: [react()],
        resolve: {
          alias: [
            { find: '@oxytocin/plugin-sdk/react', replacement: join(repo, 'packages/plugin-sdk/src/react.ts') },
            { find: '@oxytocin/plugin-sdk/theme.css', replacement: join(repo, 'packages/plugin-sdk/src/theme.css') },
            { find: /^@oxytocin\/plugin-sdk$/, replacement: join(repo, 'packages/plugin-sdk/src/index.ts') },
          ],
        },
        build: {
          outDir: join(dist, 'views'),
          emptyOutDir: true,
          // Plugin views run under a strict CSP: no inline scripts, no module preload polyfill.
          modulePreload: { polyfill: false },
          assetsInlineLimit: 0,
          rollupOptions: { input: Object.fromEntries(pages.map((p) => [p.replace(/\.html$/, ''), join(viewsDir, p)])) },
        },
      });
    }
  }
  await writeChecksums(pluginDir);
}
