import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodeMapCheckouts } from '../../src/code-map-host/checkouts';
import { ParserRuntime } from '../../src/code-map-host/parse/runtime';
import { extractTypeScript } from '../../src/code-map-host/extract/typescript';
import { normalizedSource } from '../../src/code-map-host/extract/files';
import { CodeMapService } from '../../src/main/services/code-map/code-map-service';
import { PluginHostService } from '../../src/main/services/plugins/plugin-host-service';
import { PluginRuntime } from '../../src/plugin-host/runtime';
import { CodeMapHostContracts } from '../../src/shared/rpc/contracts/code-map-host';
import { PluginManifestSchema, type PluginDescriptor } from '../../src/shared/domain/plugin';
import { CodeMapPluginResultSchema } from '../../src/shared/domain/code-map-plugin';
import { defaultSettings } from '../../src/shared/domain/settings';
import type { Project } from '../../src/shared/domain/project';
import { Emitter } from '../../src/shared/utils/emitter';
import { copyCodeMapAssets } from '../../scripts/code-map-assets';
import { silentLogger } from '../helpers/logger';

it('reads one graph through plugin and agent paths, follows invalidations and validates source ranges before navigation', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'oxy-map-plugin-'))),
    root = join(base, 'project'),
    assets = join(base, 'assets');
  await mkdir(root);
  await copyCodeMapAssets(assets);
  await writeFile(join(root, 'api.ts'), 'export function api() { return 1; }\n');
  await writeFile(join(root, 'main.ts'), "import { api } from './api';\nexport function run() { return api(); }\n");
  const parser = new ParserRuntime(assets),
    events = new Map<string, (p: unknown) => void>();
  const checkouts = new CodeMapCheckouts('Oxytocin test', (status) => events.get('checkout:status')?.(status), {
    assets,
    parserEntry: '',
    parser: {
      parse: async (path, text) => {
        const source = normalizedSource(text),
          tree = await parser.parse(source, 'typescript');
        try {
          return extractTypeScript(path, source, tree);
        } finally {
          tree.delete();
        }
      },
      dispose: () => {
        parser.dispose();
        return Promise.resolve();
      },
    },
  });
  const project: Project = {
    id: 'p',
    name: 'Fixture',
    rootPath: root,
    color: 0,
    pinned: false,
    order: 0,
    createdAt: 0,
    settings: { codeMap: { enabled: true, excludedPaths: [], ignoreInGit: false } },
  };
  type MapDeps = ConstructorParameters<typeof CodeMapService>[0];
  let advanceStatus = false;
  const host: MapDeps['host'] = {
    state: 'running',
    start: () => {},
    stop: () => Promise.resolve(),
    onDidBecomeReady: () => ({ dispose() {} }),
    onDidChangeState: () => ({ dispose() {} }),
    onEvent: (name, listener) => {
      events.set(name, listener as (p: unknown) => void);
      return { dispose() {} };
    },
    call: (async (method: string, input: unknown) => {
      if (method === 'checkout:configure') return checkouts.configure(input);
      if (method === 'query:run') {
        const p = CodeMapHostContracts['query:run'].params.parse(input);
        return checkouts.query(p.checkoutId, p.requestId, p.query);
      }
      if (method === 'query:cancel') {
        checkouts.cancelQuery(CodeMapHostContracts['query:cancel'].params.parse(input).requestId);
        return null;
      }
      if (method === 'checkout:status') {
        const status = checkouts.status(CodeMapHostContracts['checkout:status'].params.parse(input).checkoutId);
        return advanceStatus ? { ...status, generation: status.generation + 1 } : status;
      }
      if (method === 'source:locate')
        return checkouts.locateSource(CodeMapHostContracts['source:locate'].params.parse(input));
      if (method === 'checkout:remove') {
        await checkouts.remove(CodeMapHostContracts['checkout:remove'].params.parse(input).checkoutId);
        return null;
      }
      throw new Error('Unexpected host method');
    }) as MapDeps['host']['call'],
  };
  const map = new CodeMapService({
    host,
    projects: {
      get: (id) => (id === project.id ? project : undefined),
      list: () => [project],
      update: () => Promise.resolve(project),
      onDidChange: new Emitter<Project[]>().event,
    },
    gitPath: () => 'git',
    logger: silentLogger,
  });
  const pluginPath = resolve('tests/fixtures/plugins/code-map');
  const manifest = PluginManifestSchema.parse(
    (JSON.parse(await readFile(join(pluginPath, 'package.json'), 'utf8')) as { oxytocin: unknown }).oxytocin,
  );
  const descriptor: PluginDescriptor = {
    id: manifest.id,
    version: '1.0.0',
    displayName: manifest.displayName,
    path: pluginPath,
    source: 'dev',
    state: 'enabled',
    manifest,
  };
  let serve: (input: never) => unknown = () => undefined;
  const runtime = new PluginRuntime({
    call: (pluginId, method, params) => Promise.resolve(serve({ pluginId, method, params } as never)),
    state: () => {},
    busy: () => {},
    log: () => {},
  });
  const openInEditor = vi.fn(() => Promise.resolve());
  const pluginHost = new PluginHostService({
    codeMap: map,
    host: {
      state: 'running',
      call: () => Promise.resolve(),
      onEvent: () => ({ dispose() {} }),
      onDidBecomeReady: () => ({ dispose() {} }),
      serve: (impl: Record<string, (p: never) => unknown>) => {
        serve = impl['api:call']!;
        return { dispose() {} };
      },
      emit: (name: string, payload: { name: string; payload: unknown; pluginId?: string }) => {
        if (name === 'api:event') runtime?.dispatch(payload.name, payload.payload, payload.pluginId);
      },
    } as never,
    plugins: {
      get: () => descriptor,
      enabled: () => [descriptor],
      onDidChange: new Emitter<PluginDescriptor[]>().event,
      setRuntimeState: () => {},
    },
    core: { settings: () => defaultSettings('linux'), openInEditor } as never,
    env: { appVersion: 'test', platform: 'linux', locale: 'en-US', homeDir: base, userDataDir: base },
    logger: silentLogger,
  });
  try {
    await runtime.load(
      [
        {
          id: manifest.id,
          version: '1.0.0',
          path: pluginPath,
          main: join(pluginPath, 'host.js'),
          builtin: false,
          permissions: manifest.permissions,
          activationEvents: manifest.activationEvents,
          commands: manifest.contributes.commands.map((c) => c.id),
          views: [],
          panels: [],
          statusBarItems: [],
          mcpTools: [],
        },
      ],
      {},
      { appVersion: 'test', platform: 'linux', locale: 'en-US', homeDir: base, userDataDir: base },
    );
    await runtime.activateByEvent('onStartup');
    await map.start();
    await vi.waitFor(() => expect(map.status('p').state).toBe('ready'));
    const call = (id: string, ...args: unknown[]) => runtime.executeCommand(id, args);
    expect(await call('map.checkouts', 'p')).toEqual([
      { projectId: 'p', checkoutId: 'p', label: 'Main checkout', mode: 'project' },
    ]);
    const request = { projectId: 'p', checkoutId: 'p', kind: 'relations', path: 'api.ts', direction: 'incoming' };
    const fromPlugin = CodeMapPluginResultSchema.parse(await call('map.query', request));
    const fromAgent = await map.query(
      'p',
      { kind: 'relations', path: 'api.ts', direction: 'incoming' },
      new AbortController().signal,
    );
    expect(fromPlugin.data).toEqual(fromAgent.data);
    expect(fromPlugin.freshness.coverage).toEqual(fromAgent.freshness.coverage);
    const slice = CodeMapPluginResultSchema.parse(
      await call('map.query', {
        projectId: 'p',
        checkoutId: 'p',
        kind: 'slice',
        view: 'file',
        root: { path: 'api.ts' },
      }),
    );
    if (slice.data?.kind !== 'slice') throw new Error('Expected a graph slice');
    const symbol = slice.data.nodes.find((node) => node.kind === 'symbol')!;
    expect(symbol.label).toBe('api');
    const locator = {
      projectId: 'p',
      checkoutId: 'p',
      path: symbol.path!,
      sha256: symbol.sha256!,
      generation: slice.freshness.generation,
      symbolId: symbol.id,
      span: symbol.span,
    };
    await call('map.open', locator);
    expect(openInEditor).toHaveBeenLastCalledWith({
      path: join(root, 'api.ts'),
      line: symbol.span![0],
      column: symbol.span![1] + 1,
    });
    advanceStatus = true;
    const late = CodeMapPluginResultSchema.parse(
      await call('map.query', { projectId: 'p', checkoutId: 'p', kind: 'slice', view: 'overview' }),
    );
    expect(late).toMatchObject({ code: 'SNAPSHOT_CHANGED', freshness: { stale: true } });
    expect(late.data).toBeUndefined();
    advanceStatus = false;
    await writeFile(join(root, 'api.ts'), 'export function changed() {}\n');
    await expect(call('map.open', locator)).rejects.toThrow('SNAPSHOT_CHANGED');
    const stale = CodeMapPluginResultSchema.parse(
      await call('map.query', {
        projectId: 'p',
        checkoutId: 'p',
        kind: 'slice',
        view: 'file',
        root: { path: 'api.ts' },
        generation: locator.generation,
      }),
    );
    expect(stale.code).toBe('SNAPSHOT_CHANGED');
    expect(((await call('map.changes')) as unknown[]).length).toBeGreaterThan(0);
    project.settings.codeMap!.enabled = false;
    await expect(call('map.query', request)).rejects.toThrow('disabled');
  } finally {
    await runtime.dispose();
    pluginHost.dispose();
    await map.dispose();
    await checkouts.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
