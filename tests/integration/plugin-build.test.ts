import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPluginChecksums } from '../../src/main/services/plugins/checksums';
import { buildPlugin, CHECKSUM_FILE } from '../../scripts/lib/plugin-build';

const fixture = resolve(__dirname, '../fixtures/plugin-src/sample');
let dir: string;

let temp: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'oxy-plugin-build-'));
  await cp(fixture, join(temp, 'real/sample'), { recursive: true });
  // Built through a symlinked folder, like macOS' /var → /private/var temp paths.
  await symlink(join(temp, 'real'), join(temp, 'link'), 'junction');
  dir = join(temp, 'link/sample');
  await buildPlugin(dir);
}, 60_000);

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('buildPlugin', () => {
  it('bundles the backend into a self-contained ES module', async () => {
    const host = await readFile(join(dir, 'dist/host.js'), 'utf8');
    expect(host).toContain('hello from');
    expect(host).not.toMatch(/from ['"]\.\/greeting/);
    const mod = (await import(`${join(dir, 'dist/host.js')}?t=${Date.now()}`)) as { activate: unknown };
    expect(typeof mod.activate).toBe('function');
  });

  it('builds views with relative asset paths and no inline scripts', async () => {
    const html = await readFile(join(dir, 'dist/views/main.html'), 'utf8');
    expect(html).toMatch(/<script type="module"[^>]*src="\.\/assets\/[^"]+\.js"/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
    const assets = await readdir(join(dir, 'dist/views/assets'));
    const script = await readFile(
      join(
        dir,
        'dist/views/assets',
        assets.find((a) => a.endsWith('.js'))!,
      ),
      'utf8',
    );
    // The SDK is bundled in.
    expect(script).toContain('oxy:hello');
  });

  it('writes checksums of the shipped files that verify until a file changes', async () => {
    const sums = JSON.parse(await readFile(join(dir, CHECKSUM_FILE), 'utf8')) as Record<string, string>;
    expect(Object.keys(sums)).toEqual(
      expect.arrayContaining(['package.json', 'README.md', 'dist/host.js', 'dist/views/main.html']),
    );
    expect(Object.keys(sums).some((k) => k.startsWith('src/'))).toBe(false);
    expect(await verifyPluginChecksums(dir)).toEqual([]);

    await writeFile(join(dir, 'dist/host.js'), 'export function activate() { /* tampered */ }\n');
    await rm(join(dir, 'README.md'));
    expect(await verifyPluginChecksums(dir)).toEqual(
      expect.arrayContaining(['dist/host.js was modified', 'README.md is missing']),
    );
  });

  it('reports a missing checksum file and rejects paths leaving the plugin', async () => {
    const other = await mkdtemp(join(tmpdir(), 'oxy-plugin-sums-'));
    try {
      expect(await verifyPluginChecksums(other)).toEqual([`${CHECKSUM_FILE} is missing or unreadable`]);
      await writeFile(join(other, CHECKSUM_FILE), JSON.stringify({ '../x': 'abc' }));
      expect(await verifyPluginChecksums(other)).toEqual([`invalid path in ${CHECKSUM_FILE}: ../x`]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
