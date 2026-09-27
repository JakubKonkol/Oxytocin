import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginManifestSchema } from '../../src/shared/domain/plugin';
import { PluginInstaller } from '../../src/main/services/plugins/plugin-installer';
import { render, scaffold, validateId } from '../../packages/create-oxytocin-plugin/lib/scaffold.js';
import { silentLogger } from '../helpers/logger';

const repo = resolve(__dirname, '../..');
// Inside the repository so the generated projects resolve esbuild, Vite, React and TypeScript from its node_modules.
let work: string;

beforeAll(async () => {
  await mkdir(join(repo, 'node_modules/.cache'), { recursive: true });
  work = await mkdtemp(join(repo, 'node_modules/.cache/oxy-create-test-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

const node = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: 'pipe' });

describe('create-oxytocin-plugin', () => {
  it('validates ids and renders placeholders', () => {
    expect(validateId('acme.hello')).toBeNull();
    expect(validateId('Acme.Hello')).toMatch(/publisher\.name/);
    expect(validateId('hello')).toMatch(/publisher\.name/);
    expect(render('{{name}} / {{missing}}', { name: 'X' })).toBe('X / {{missing}}');
  });

  for (const template of ['vanilla', 'react'] as const) {
    it(`${template}: generates a project that type-checks, builds, packages and installs`, async () => {
      const dir = join(work, template);
      const files = await scaffold({
        targetDir: dir,
        id: `acme.${template}-demo`,
        name: 'Demo',
        publisher: 'acme',
        template,
      });
      expect(files).toEqual(
        expect.arrayContaining([
          '.gitignore',
          'LICENSE',
          'README.md',
          'build.mjs',
          'package.json',
          'src/host.ts',
          'tsconfig.json',
          'vendor/plugin-api/index.d.ts',
          'vendor/plugin-sdk/index.ts',
          `src/views/main.${template === 'react' ? 'tsx' : 'ts'}`,
        ]),
      );
      expect(files.join('\n')).not.toContain('_gitignore');
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { oxytocin: unknown };
      const manifest = PluginManifestSchema.parse(pkg.oxytocin);
      expect(manifest).toMatchObject({
        id: `acme.${template}-demo`,
        main: 'dist/host.js',
        permissions: ['projects.read'],
      });
      expect(await readFile(join(dir, 'src/host.ts'), 'utf8')).not.toContain('{{');

      node(dir, join(repo, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json');
      node(dir, 'build.mjs', '--zip');
      const host = (await import(`${join(dir, 'dist/host.js')}?t=${Date.now()}`)) as { activate: unknown };
      expect(typeof host.activate).toBe('function');
      const html = await readFile(join(dir, 'dist/views/main.html'), 'utf8');
      expect(html).toMatch(/src="\.\/assets\/[^"]+\.js"/);

      const userDir = join(work, `${template}-userData`, 'plugins');
      const installed = await new PluginInstaller(userDir, silentLogger).install(
        join(dir, `acme.${template}-demo-0.1.0.zip`),
      );
      expect(installed).toMatchObject({ id: `acme.${template}-demo`, version: '0.1.0' });
      expect((await stat(join(userDir, installed.id, 'dist/views/main.html'))).isFile()).toBe(true);
    }, 120_000);
  }

  it('refuses a folder that is not empty', async () => {
    const dir = join(work, 'busy');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x'), '');
    await expect(scaffold({ targetDir: dir, id: 'acme.x', name: 'X', publisher: 'acme' })).rejects.toThrow(/not empty/);
    await expect(scaffold({ targetDir: join(work, 'bad'), id: 'X', name: 'X', publisher: 'acme' })).rejects.toThrow(
      /publisher\.name/,
    );
  });
});
