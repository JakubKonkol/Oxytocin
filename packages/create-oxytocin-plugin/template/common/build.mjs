// Builds the plugin:
//   src/host.ts        → dist/host.js     (esbuild; the backend runs in Oxytocin's Plugin Host, Node.js)
//   src/views/*.html   → dist/views/      (Vite; views run in sandboxed iframes, no network access)
//
//   node build.mjs          build once
//   node build.mjs --watch  rebuild on changes (Oxytocin reloads the plugin in developer mode)
//   node build.mjs --zip    build, then create <id>-<version>.zip for "Install from .zip…"
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { build as esbuild, context } from 'esbuild';
import { build as viteBuild } from 'vite';

const root = import.meta.dirname;
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const watch = process.argv.includes('--watch');
const USES_REACT = '{{react}}' === 'true';

const hostOptions = {
  entryPoints: { host: join(root, 'src/host.ts') },
  outdir: join(root, 'dist'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'linked',
  // CommonJS dependencies bundled into ESM need `require` for Node built-ins.
  banner: { js: "import { createRequire as __oxyRequire } from 'node:module'; const require = __oxyRequire(import.meta.url);" },
  logLevel: 'info',
};

async function buildViews() {
  const viewsDir = join(root, 'src/views');
  const pages = (await readdir(viewsDir)).filter((f) => f.endsWith('.html'));
  const plugins = USES_REACT ? [(await import('@vitejs/plugin-react')).default()] : [];
  await viteBuild({
    root: viewsDir,
    base: './',
    configFile: false,
    logLevel: 'warn',
    plugins,
    resolve: {
      alias: [
        { find: '@oxytocin/plugin-sdk/react', replacement: join(root, 'vendor/plugin-sdk/react.ts') },
        { find: '@oxytocin/plugin-sdk/theme.css', replacement: join(root, 'vendor/plugin-sdk/theme.css') },
        { find: /^@oxytocin\/plugin-sdk$/, replacement: join(root, 'vendor/plugin-sdk/index.ts') },
      ],
    },
    build: {
      outDir: join(root, 'dist/views'),
      emptyOutDir: true,
      // Views run under a strict CSP: no inline scripts, no module preload polyfill, no inlined assets.
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      rollupOptions: { input: Object.fromEntries(pages.map((p) => [p.replace(/\.html$/, ''), join(viewsDir, p)])) },
      ...(watch ? { watch: {} } : {}),
    },
  });
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

/** A .zip with what Oxytocin needs: package.json, dist/, README.md, LICENSE and the icon. */
async function writeZip() {
  const files = [join(root, 'package.json'), ...(await listFiles(join(root, 'dist')))];
  for (const extra of ['README.md', 'LICENSE', 'icon.png', 'icon.svg'])
    if (await stat(join(root, extra)).catch(() => null)) files.push(join(root, extra));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(root, file).split(sep).join('/'), 'utf8');
    const data = await readFile(file);
    const packed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, name, packed);
    centrals.push(central, name);
    offset += header.length + name.length + packed.length;
  }
  const size = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  const out = join(root, `${pkg.oxytocin.id}-${pkg.version}.zip`);
  await writeFile(out, Buffer.concat([...locals, ...centrals, end]));
  console.log(`Created ${relative(process.cwd(), out)} (${files.length} files)`);
}

await rm(join(root, 'dist'), { recursive: true, force: true });
if (watch) {
  const ctx = await context(hostOptions);
  await ctx.watch();
  await buildViews();
  console.log('Watching for changes…');
} else {
  await esbuild(hostOptions);
  await buildViews();
  if (process.argv.includes('--zip')) await writeZip();
}
