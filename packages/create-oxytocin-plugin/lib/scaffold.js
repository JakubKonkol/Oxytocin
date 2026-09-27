// Scaffolding logic of create-oxytocin-plugin (no dependencies: runs with `npm create oxytocin-plugin`).
import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATES = ['vanilla', 'react'];

/** Same rule as the plugin manifest: lowercase, dot-separated ("publisher.name"). */
export function validateId(id) {
  return /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(id)
    ? null
    : 'The id must look like "publisher.name" (lowercase letters, digits, dots, dashes).';
}

export function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plugin'
  );
}

export function titleCase(text) {
  return String(text)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** Prefix of the plugin's commands, panel type and status bar item: the last part of the id. */
export function commandPrefix(id) {
  return id.split('.').at(-1);
}

/** Where the vendored SDK and API types come from: `vendor/` in the published package, the monorepo otherwise. */
export async function vendorSources(packageDir = PACKAGE_DIR) {
  const vendor = join(packageDir, 'vendor');
  if (await exists(join(vendor, 'plugin-sdk', 'index.ts')))
    return { sdk: join(vendor, 'plugin-sdk'), api: join(vendor, 'plugin-api') };
  return { sdk: join(packageDir, '..', 'plugin-sdk', 'src'), api: join(packageDir, '..', 'plugin-api') };
}

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function render(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

async function renderTree(dir, vars) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await renderTree(path, vars);
    else if (/\.(ts|tsx|js|mjs|json|html|css|md)$|^LICENSE$|^_gitignore$/.test(entry.name))
      await writeFile(path, render(await readFile(path, 'utf8'), vars));
    if (entry.name === '_gitignore') await rename(path, join(dir, '.gitignore'));
  }
}

function packageJson({ id, name, publisher, template, apiVersion, packageName, prefix }) {
  const react = template === 'react';
  return {
    name: packageName,
    version: '0.1.0',
    description: `${name} — an Oxytocin plugin`,
    license: 'MIT',
    private: true,
    type: 'module',
    scripts: {
      build: 'node build.mjs',
      dev: 'node build.mjs --watch',
      package: 'node build.mjs --zip',
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      '@types/node': '^24.0.0',
      esbuild: '^0.25.0',
      typescript: '~6.0.0',
      vite: '^7.0.0',
      ...(react
        ? {
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^5.0.0',
            react: '^19.0.0',
            'react-dom': '^19.0.0',
          }
        : {}),
    },
    oxytocin: {
      id,
      displayName: name,
      description: `${name} for Oxytocin.`,
      publisher,
      engine: `^${apiVersion}`,
      main: 'dist/host.js',
      activationEvents: ['onStartup'],
      permissions: ['projects.read'],
      contributes: {
        commands: [
          { id: `${prefix}.open`, title: `${name}: Open` },
          { id: `${prefix}.hello`, title: `${name}: Say Hello` },
        ],
        panels: [{ type: `${prefix}.main`, title: name, entry: 'dist/views/main.html' }],
        statusBarItems: [{ id: `${prefix}.status`, alignment: 'right', priority: 50 }],
      },
    },
  };
}

/**
 * Creates the plugin project in `targetDir` (missing or empty). Returns the relative paths of the created files.
 */
export async function scaffold({ targetDir, id, name, publisher, template = 'vanilla', packageDir = PACKAGE_DIR }) {
  const problem = validateId(id);
  if (problem) throw new Error(problem);
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}" (${TEMPLATES.join(', ')}).`);
  if ((await exists(targetDir)) && (await readdir(targetDir)).length > 0) throw new Error(`${targetDir} is not empty.`);
  await mkdir(targetDir, { recursive: true });
  const templates = join(packageDir, 'template');
  await cp(join(templates, 'common'), targetDir, { recursive: true });
  await cp(join(templates, template), targetDir, { recursive: true });

  const { sdk, api } = await vendorSources(packageDir);
  await mkdir(join(targetDir, 'vendor', 'plugin-sdk'), { recursive: true });
  for (const file of ['index.ts', 'protocol.ts', 'theme.css', ...(template === 'react' ? ['react.ts'] : [])])
    await cp(join(sdk, file), join(targetDir, 'vendor', 'plugin-sdk', file));
  await mkdir(join(targetDir, 'vendor', 'plugin-api'), { recursive: true });
  await cp(join(api, 'index.d.ts'), join(targetDir, 'vendor', 'plugin-api', 'index.d.ts'));
  const apiVersion = JSON.parse(await readFile(join(api, 'package.json'), 'utf8')).version;
  await cp(join(api, 'package.json'), join(targetDir, 'vendor', 'plugin-api', 'package.json'));

  const prefix = commandPrefix(id);
  const vars = {
    id,
    name,
    publisher,
    prefix,
    year: new Date().getFullYear(),
    react: template === 'react',
    apiVersion,
  };
  await renderTree(targetDir, vars);
  const pkg = packageJson({ id, name, publisher, template, apiVersion, packageName: slug(id), prefix });
  await writeFile(join(targetDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return listFiles(targetDir);
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path, base)));
    else
      out.push(
        path
          .slice(base.length + 1)
          .split('\\')
          .join('/'),
      );
  }
  return out.sort();
}
