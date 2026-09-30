import { describe, expect, it, vi } from 'vitest';
import type { McpToolDefinition } from '@shared/domain/mcp';
import { McpToolRegistry, type PluginToolSource } from './tool-registry';

const tool = (name: string, extra: Partial<McpToolDefinition> = {}): McpToolDefinition => ({
  name,
  description: `${name} does things.`,
  inputSchema: { type: 'object' },
  ...extra,
});

const plugin = (
  id: string,
  prefix: string,
  tools: string[],
  extra: Partial<PluginToolSource> = {},
): PluginToolSource => ({
  pluginId: id,
  pluginName: id.split('.')[1]!,
  builtin: false,
  prefix,
  declared: tools.map((t) => tool(t)),
  available: true,
  ...extra,
});

describe('McpToolRegistry', () => {
  it('lists core tools and tools of available plugins, sorted by name', () => {
    const r = new McpToolRegistry();
    r.setCore([tool('oxy_b'), tool('oxy_a')]);
    r.setPlugins([
      plugin('acme.tests', 'tests', ['tests_run']),
      plugin('acme.off', 'off', ['off_x'], { available: false }),
    ]);
    expect(r.listed().map((e) => e.name)).toEqual(['oxy_a', 'oxy_b', 'tests_run']);
    const off = r.all().find((t) => t.name === 'off_x')!;
    expect(off).toMatchObject({ listed: false, problem: 'The plugin is turned off.' });
    expect(r.resolve('tests_run')?.source).toEqual({ kind: 'plugin', pluginId: 'acme.tests', pluginName: 'tests' });
    expect(r.resolve('off_x')).toBeUndefined();
  });

  it('hides tools the user turned off or denied, and derives default policies', () => {
    const r = new McpToolRegistry();
    r.setCore([tool('oxy_read'), tool('oxy_rm', { annotations: { destructiveHint: true } }), tool('oxy_x')], {
      oxy_read: 'ask',
    });
    r.setSettings({ disabled: ['oxy_x'], policies: {} });
    expect(r.listed().map((e) => [e.name, e.policy])).toEqual([
      ['oxy_read', 'ask'],
      ['oxy_rm', 'ask'],
    ]);
    r.setSettings({ disabled: [], policies: { oxy_rm: 'deny', oxy_read: 'allow' } });
    expect(r.listed().map((e) => [e.name, e.policy])).toEqual([
      ['oxy_read', 'allow'],
      ['oxy_x', 'allow'],
    ]);
    expect(r.all().find((t) => t.name === 'oxy_read')).toMatchObject({ policy: 'allow', defaultPolicy: 'ask' });
    expect(r.all().find((t) => t.name === 'oxy_rm')).toMatchObject({ listed: false, enabled: true, policy: 'deny' });
  });

  it('gives a contested prefix to the built-in plugin and reports the other one', () => {
    const r = new McpToolRegistry();
    r.setPlugins([
      plugin('zeta.run', 'run', ['run_other']),
      plugin('oxytocin.project-runner', 'run', ['run_start'], { builtin: true, pluginName: 'Project Runner' }),
    ]);
    expect(r.listed().map((e) => e.name)).toEqual(['run_start']);
    expect(r.problems().get('zeta.run')).toMatch(/already used by Project Runner/);
    expect(r.all().find((t) => t.name === 'run_other')?.problem).toMatch(/prefix "run"/);
  });

  it('adds and removes runtime tools and drops them with their host', () => {
    const r = new McpToolRegistry();
    const changes = vi.fn();
    r.onDidChange(changes);
    r.setPlugins([plugin('acme.db', 'db', ['db_status'])]);
    r.addDynamic('acme.db', tool('db_query', { title: 'Query' }));
    expect(r.listed().map((e) => [e.name, e.dynamic])).toEqual([
      ['db_query', true],
      ['db_status', false],
    ]);
    expect(() => r.addDynamic('acme.db', tool('other_x'))).toThrow(/prefix "db_"/);
    expect(() => r.addDynamic('acme.db', tool('db_status'))).toThrow(/declared in the manifest/);
    expect(() => r.addDynamic('acme.db', { name: 'db_bad', inputSchema: { type: 'array' } })).toThrow(/Invalid tool/);
    expect(() => r.addDynamic('acme.none', tool('x_y'))).toThrow(/does not declare/);
    r.removeDynamic('acme.db', 'db_query');
    expect(r.listed().map((e) => e.name)).toEqual(['db_status']);
    r.addDynamic('acme.db', tool('db_query'));
    r.dropDynamic(['acme.db']);
    expect(r.listed().map((e) => e.name)).toEqual(['db_status']);
    expect(changes).toHaveBeenCalled();
  });

  it('has a stable key that changes only with what agents see', () => {
    const r = new McpToolRegistry();
    r.setPlugins([plugin('acme.db', 'db', ['db_status'])]);
    const before = r.listedKey();
    r.setPlugins([plugin('acme.db', 'db', ['db_status'])]);
    expect(r.listedKey()).toBe(before);
    r.setSettings({ disabled: ['db_status'], policies: {} });
    expect(r.listedKey()).not.toBe(before);
  });
});
