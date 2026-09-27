import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../helpers/logger';
import { makeZip } from '../helpers/zip';
import { PluginInstaller } from '../../src/main/services/plugins/plugin-installer';

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'hello-plugin',
    version: '1.0.0',
    oxytocin: {
      id: 'acme.hello',
      displayName: 'Hello',
      publisher: 'acme',
      engine: '^0.1.0',
      main: 'host.js',
      permissions: ['projects.read'],
      ...over,
    },
  });

let base: string;
let userDir: string;
let installer: PluginInstaller;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'oxy-install-'));
  userDir = join(base, 'userData', 'plugins');
  installer = new PluginInstaller(userDir, silentLogger, '0.1.1');
});

async function pluginFolder(pkg = manifest(), files: Record<string, string> = { 'host.js': 'export {}' }) {
  const dir = await mkdtemp(join(base, 'src-'));
  await writeFile(join(dir, 'package.json'), pkg);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

async function zipFile(entries: Parameters<typeof makeZip>[0]) {
  const path = join(base, `p-${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(path, makeZip(entries));
  return path;
}

describe('PluginInstaller', () => {
  it('installs from a folder into userData/plugins/<id>, without .git', async () => {
    const src = await pluginFolder(manifest(), { 'host.js': 'export {}', '.git/HEAD': 'ref', 'views/a.html': '<p>' });
    expect(await installer.install(src)).toEqual({
      id: 'acme.hello',
      displayName: 'Hello',
      version: '1.0.0',
      replaced: false,
      needsNewConsent: true,
    });
    expect((await readdir(join(userDir, 'acme.hello'))).sort()).toEqual(['host.js', 'package.json', 'views']);
    expect(await readdir(userDir)).toEqual(['acme.hello']);
  });

  it('installs from a zip with a top-level folder', async () => {
    const zip = await zipFile([
      { name: 'hello/' },
      { name: 'hello/package.json', data: manifest() },
      { name: 'hello/host.js', data: 'export const x = 1;' },
    ]);
    await installer.install(zip);
    expect(await readFile(join(userDir, 'acme.hello', 'host.js'), 'utf8')).toBe('export const x = 1;');
  });

  it('rejects unsafe archives and invalid plugins without touching the plugins folder', async () => {
    const symlink = await zipFile([
      { name: 'package.json', data: manifest() },
      { name: 'host.js', data: 'x' },
      { name: 'link', data: '/etc/passwd', mode: 0o120777 },
    ]);
    await installer.install(symlink);
    expect((await readdir(join(userDir, 'acme.hello'))).sort()).toEqual(['host.js', 'package.json']);

    const traversal = await zipFile([{ name: '../evil.js', data: 'x' }]);
    await expect(installer.install(traversal)).rejects.toThrow(/zip/i);
    await expect(installer.install(await zipFile([{ name: 'readme.md', data: '#' }]))).rejects.toThrow(
      /No Oxytocin plugin/,
    );
    await expect(installer.install(await pluginFolder(manifest(), {}))).rejects.toThrow(/main: file not found/);
    await expect(installer.install(await pluginFolder(manifest({ engine: '^2.0.0' })))).rejects.toThrow(
      /requires Oxytocin API \^2.0.0/,
    );
    await expect(installer.install(join(base, 'missing'))).rejects.toThrow(/does not exist/);
    await writeFile(join(base, 'x.txt'), '');
    await expect(installer.install(join(base, 'x.txt'))).rejects.toThrow(/folder or a .zip/);
    expect(await readdir(userDir)).toEqual(['acme.hello']);
  });

  it('replaces an installed version and asks for consent again only when permissions change', async () => {
    await installer.install(await pluginFolder());
    const same = await installer.install(await pluginFolder(manifest().replace('1.0.0', '1.1.0')));
    expect(same).toMatchObject({ version: '1.1.0', replaced: true, needsNewConsent: false });
    const more = await installer.install(await pluginFolder(manifest({ permissions: ['projects.read', 'git.read'] })));
    expect(more).toMatchObject({ replaced: true, needsNewConsent: true });
    expect(await readdir(userDir)).toEqual(['acme.hello']);
  });

  it('uninstalls only folders inside the plugins folder', async () => {
    await installer.install(await pluginFolder());
    await expect(installer.uninstall('x', base)).rejects.toThrow(/not an installed plugin/);
    await installer.uninstall('acme.hello', join(userDir, 'acme.hello'));
    expect(await readdir(userDir)).toEqual([]);
  });
});
