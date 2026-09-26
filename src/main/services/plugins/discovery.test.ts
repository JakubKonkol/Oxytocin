import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveSettings } from '@shared/domain/settings';
import { PluginManifestSchema } from '@shared/domain/plugin';
import {
  collectContributions,
  describePlugins,
  type DiscoveryFs,
  isEngineCompatible,
  resolveConflicts,
  scanDir,
} from './discovery';
import { PluginService } from './plugin-service';

function memoryFs(files: Record<string, string>): DiscoveryFs {
  const norm = (p: string) => p.split('\\').join('/');
  const all = Object.fromEntries(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    readdir: (dir) => {
      const prefix = `${norm(dir)}/`;
      const names = new Set(
        Object.keys(all)
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length).split('/')[0]!),
      );
      return names.size ? Promise.resolve([...names]) : Promise.reject(new Error('ENOENT'));
    },
    readFile: (p) => (norm(p) in all ? Promise.resolve(all[norm(p)]!) : Promise.reject(new Error('ENOENT'))),
    exists: (p) => Promise.resolve(Object.keys(all).some((k) => k === norm(p) || k.startsWith(`${norm(p)}/`))),
  };
}

const pkg = (oxytocin: Record<string, unknown>, version = '1.0.0') => JSON.stringify({ name: 'x', version, oxytocin });
const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: id,
  publisher: 'test',
  engine: '^0.1.0',
  ...extra,
});

describe('plugin manifest', () => {
  it('accepts a full manifest and applies defaults', () => {
    const m = PluginManifestSchema.parse(
      manifest('oxytocin.usage-monitor', {
        main: 'dist/host.js',
        activationEvents: ['onStartup', 'onView:usage.sidebar', 'onCommand:usage.open'],
        permissions: ['terminals.env', 'net.fetch'],
        contributes: {
          views: [{ id: 'usage.sidebar', slot: 'sidebar', title: 'Usage', entry: 'dist/views/sidebar.html' }],
          panels: [{ type: 'usage.dashboard', title: 'Usage', entry: 'dist/views/d.html', singleton: 'global' }],
          statusBarItems: [{ id: 'usage.today' }],
          configuration: { prefix: 'usage', properties: { 'usage.x': { type: 'boolean', default: true } } },
        },
      }),
    );
    expect(m.contributes.views[0]!.order).toBe(1000);
    expect(m.contributes.statusBarItems[0]).toEqual({ id: 'usage.today', alignment: 'right', priority: 0 });
    expect(m.contributes.fileOpeners).toEqual([]);
  });

  it.each([
    [{ id: 'NoDots' }, 'id'],
    [{ activationEvents: ['onSomething'] }, 'activationEvents'],
    [{ permissions: ['fs.write-everything'] }, 'permissions'],
    [{ main: '../outside.js' }, 'main'],
    [{ main: 'C:\\abs.js' }, 'main'],
    [{ contributes: { configuration: { prefix: 'a', properties: { 'b.x': { type: 'string' } } } } }, 'configuration'],
  ])('rejects %o', (patch, where) => {
    const result = PluginManifestSchema.safeParse({ ...manifest('a.b'), ...patch });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(where);
  });
});

describe('plugin discovery', () => {
  const fs = memoryFs({
    '/b/echo/package.json': pkg(manifest('test.echo', { main: 'dist/host.js' })),
    '/b/echo/dist/host.js': '',
    '/b/broken/package.json': '{ not json',
    '/b/not-a-plugin/package.json': JSON.stringify({ name: 'lib' }),
    '/b/missing-file/package.json': pkg(manifest('test.missing', { main: 'dist/host.js' })),
    '/b/old/package.json': pkg(manifest('test.old', { engine: '^9.0.0' })),
    '/u/echo/package.json': pkg(manifest('test.echo'), '2.0.0'),
    '/u/extra/package.json': pkg(manifest('test.extra')),
  });

  it('scans folders, reports broken manifests and missing files', async () => {
    const found = await scanDir('/b', 'builtin', fs);
    expect(found.map((c) => [c.id ?? c.path, c.errors.length > 0])).toEqual([
      [join('/b', 'broken'), true],
      ['test.echo', false],
      ['test.missing', true],
      ['test.old', false],
    ]);
    expect(found.find((c) => c.id === 'test.missing')!.errors[0]).toMatch(/main: file not found/);
  });

  it('resolves id conflicts (dev > user > builtin) and derives states', async () => {
    const all = [...(await scanDir('/b', 'builtin', fs)), ...(await scanDir('/u', 'user', fs))];
    const resolved = resolveConflicts(all);
    const echo = resolved.find((c) => c.id === 'test.echo')!;
    expect(echo.source).toBe('user');
    expect(echo.shadowed.map((s) => s.source)).toEqual(['builtin']);
    const described = describePlugins(resolved, { 'test.extra': true }, '0.1.0');
    const state = (id: string) => described.find((d) => d.id === id)?.state;
    expect(state('test.old')).toBe('incompatible');
    expect(described.find((d) => d.id === 'test.old')!.errors![0]).toMatch(/requires Oxytocin API \^9\.0\.0/);
    expect(state('test.missing')).toBe('invalid');
    // User plugins stay disabled until enabled explicitly; builtin ones are enabled by default.
    expect(state('test.echo')).toBe('disabled');
    expect(state('test.extra')).toBe('enabled');
  });

  it('checks engine ranges', () => {
    expect(isEngineCompatible('^0.1.0', '0.1.0')).toBe(true);
    expect(isEngineCompatible('>=0.1 <0.3', '0.2.4')).toBe(true);
    expect(isEngineCompatible('^0.2.0', '0.1.0')).toBe(false);
    expect(isEngineCompatible('not a range', '0.1.0')).toBe(false);
  });

  it('marks clashing configuration prefixes invalid and collects contributions', async () => {
    const fs2 = memoryFs({
      '/b/a/package.json': pkg(
        manifest('test.a', {
          contributes: {
            configuration: { prefix: 'same', properties: {} },
            views: [
              { id: 'late', slot: 'sidebar', title: 'Late', entry: 'v.html', order: 500 },
              { id: 'early', slot: 'sidebar', title: 'Early', entry: 'v.html', order: 10 },
            ],
            fileOpeners: [{ id: 'md', extensions: ['.md'], panelType: 'md.preview', title: 'Preview' }],
          },
        }),
      ),
      '/b/a/v.html': '',
      '/b/b/package.json': pkg(
        manifest('test.b', { contributes: { configuration: { prefix: 'same', properties: {} } } }),
      ),
    });
    const described = describePlugins(resolveConflicts(await scanDir('/b', 'builtin', fs2)), {}, '0.1.0');
    expect(described.find((d) => d.id === 'test.b')).toMatchObject({ state: 'invalid' });
    const c = collectContributions(described);
    expect(c.views.map((v) => v.id)).toEqual(['early', 'late']);
    expect(c.fileOpeners).toEqual([expect.objectContaining({ pluginId: 'test.a', default: false })]);
    expect(c.configuration.map((x) => x.pluginId)).toEqual(['test.a']);
  });

  it('PluginService toggles plugins through settings and tracks runtime states', async () => {
    let raw: Record<string, unknown> = {};
    const service = new PluginService({
      builtinDir: '/b',
      userDir: '/u',
      settings: () => resolveSettings(raw, 'linux').settings,
      updateSettings: (patch) => {
        raw = { ...raw, ...patch };
        return Promise.resolve();
      },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      fs,
    });
    await service.scan();
    expect(service.get('test.extra')?.state).toBe('disabled');
    await service.setEnabled('test.extra', true);
    expect(service.get('test.extra')?.state).toBe('enabled');
    service.setRuntimeState('test.extra', 'failed', 'activate threw');
    expect(service.get('test.extra')).toMatchObject({ state: 'failed', errors: ['activate threw'] });
    await service.setEnabled('test.extra', false);
    expect(service.get('test.extra')?.state).toBe('disabled');
    await expect(service.setEnabled('nope', true)).rejects.toThrow(/not found/);
  });
});
