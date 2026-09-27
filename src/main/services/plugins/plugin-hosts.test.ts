import { describe, expect, it, vi } from 'vitest';
import type { PluginDescriptor } from '@shared/domain/plugin';
import { Emitter } from '@shared/utils/emitter';
import { PluginHosts, scopedPlugins } from './plugin-hosts';
import type { EnvContribution, PluginHostService, StatusBarItemState } from './plugin-host-service';

const plugin = (id: string, source: PluginDescriptor['source'], commands: string[] = []): PluginDescriptor =>
  ({
    id,
    version: '1.0.0',
    displayName: id,
    source,
    path: `/p/${id}`,
    state: 'enabled',
    manifest: { contributes: { commands: commands.map((c) => ({ id: c, title: c })) } },
  }) as unknown as PluginDescriptor;

function fakeHost(views: string[] = []) {
  const status = new Emitter<StatusBarItemState[]>();
  const env = new Emitter<EnvContribution[]>();
  return {
    reload: vi.fn(() => Promise.resolve()),
    reloadPlugin: vi.fn(() => Promise.resolve()),
    activateByEvent: vi.fn((e: string) => Promise.resolve([`${e}@host`])),
    executeCommand: vi.fn(() => Promise.resolve('ok')),
    logs: vi.fn(() => Promise.resolve([])),
    envBarrier: vi.fn(() => Promise.resolve()),
    viewOpened: vi.fn(() => Promise.resolve()),
    viewClosed: vi.fn(() => Promise.resolve()),
    viewVisibility: vi.fn(() => Promise.resolve()),
    viewMessage: vi.fn(() => Promise.resolve()),
    hasView: (id: string) => views.includes(id),
    notifyProjects: vi.fn(),
    notifyActiveProject: vi.fn(),
    notifyTerminal: vi.fn(),
    notifyTerminalRemoved: vi.fn(),
    notifyAgents: vi.fn(),
    notifyGitStatus: vi.fn(),
    notifySettings: vi.fn(),
    statusBarItems: new Map<string, StatusBarItemState>(),
    environments: new Map<string, EnvContribution>(),
    onDidChangeStatusBar: status.event,
    onDidChangeEnvironment: env.event,
    fireStatus: () => status.fire([]),
  } satisfies Partial<PluginHostService> & Record<string, unknown>;
}

describe('PluginHosts', () => {
  const list = [plugin('oxytocin.usage', 'builtin', ['usage.show']), plugin('acme.x', 'user', ['x.run'])];
  const plugins = { list: () => list, get: (id: string) => list.find((p) => p.id === id) };

  it('routes plugin requests to the host of the plugin and broadcasts core events', async () => {
    const builtin = fakeHost(['v-builtin']);
    const external = fakeHost(['v-ext']);
    const hosts = new PluginHosts(builtin, external, plugins);
    await hosts.executeCommand('x.run', []);
    expect(external.executeCommand).toHaveBeenCalledWith('x.run', []);
    await hosts.executeCommand('usage.show', []);
    expect(builtin.executeCommand).toHaveBeenCalledWith('usage.show', []);
    await hosts.logs('acme.x');
    expect(external.logs).toHaveBeenCalledWith('acme.x');
    await hosts.viewClosed('v-ext');
    expect(external.viewClosed).toHaveBeenCalledWith('v-ext');
    expect(builtin.viewClosed).not.toHaveBeenCalled();
    expect(await hosts.activateByEvent('onStartup')).toEqual(['onStartup@host', 'onStartup@host']);
    hosts.notifyActiveProject('p1');
    expect(builtin.notifyActiveProject).toHaveBeenCalledWith('p1');
    expect(external.notifyActiveProject).toHaveBeenCalledWith('p1');
  });

  it('merges status bar items from both hosts', () => {
    const builtin = fakeHost();
    const external = fakeHost();
    builtin.statusBarItems.set('a', { pluginId: 'oxytocin.usage', id: 'a', text: 'A', visible: true });
    external.statusBarItems.set('b', { pluginId: 'acme.x', id: 'b', text: 'B', visible: true });
    const hosts = new PluginHosts(builtin, external, plugins);
    const seen = vi.fn();
    hosts.onDidChangeStatusBar(seen);
    external.fireStatus();
    expect(seen).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })]);
  });

  it('scopes the plugin set of each host by source', () => {
    const service = {
      enabled: () => [...list, plugin('dev.y', 'dev')],
      get: (id: string) => [...list, plugin('dev.y', 'dev')].find((p) => p.id === id),
      onDidChange: new Emitter<PluginDescriptor[]>().event,
      setRuntimeState: vi.fn(),
    };
    expect(
      scopedPlugins(service, true)
        .enabled()
        .map((p) => p.id),
    ).toEqual(['oxytocin.usage']);
    expect(
      scopedPlugins(service, false)
        .enabled()
        .map((p) => p.id),
    ).toEqual(['acme.x', 'dev.y']);
    expect(scopedPlugins(service, true).get('acme.x')).toBeUndefined();
  });
});
