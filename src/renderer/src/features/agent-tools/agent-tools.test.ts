import { describe, expect, it } from 'vitest';
import type { McpToolInfo } from '@shared/domain/mcp';
import { groupTools, toggleTool, withPolicy } from './AgentToolsView';

const tool = (name: string, source: McpToolInfo['source']): McpToolInfo => ({
  name,
  description: 'x',
  source,
  enabled: true,
  policy: 'allow',
  defaultPolicy: 'allow',
  listed: true,
});

describe('Agent tools settings', () => {
  it('turns tools off and on', () => {
    expect(toggleTool([], 'a', false)).toEqual(['a']);
    expect(toggleTool(['a', 'b'], 'a', true)).toEqual(['b']);
    expect(toggleTool(['a'], 'a', false)).toEqual(['a']);
  });

  it('stores only policies that differ from the default', () => {
    const t = { name: 'x_rm', defaultPolicy: 'ask' as const };
    expect(withPolicy({}, t, 'allow')).toEqual({ x_rm: 'allow' });
    expect(withPolicy({ x_rm: 'allow', y: 'deny' }, t, 'ask')).toEqual({ y: 'deny' });
  });

  it('groups tools by source, Oxytocin first', () => {
    const groups = groupTools([
      tool('oxy_a', { kind: 'core' }),
      tool('run_start', { kind: 'plugin', pluginId: 'p', pluginName: 'Project Runner' }),
      tool('oxy_b', { kind: 'core' }),
    ]);
    expect(groups.map((g) => [g.source, g.tools.map((t) => t.name)])).toEqual([
      ['Oxytocin', ['oxy_a', 'oxy_b']],
      ['Project Runner', ['run_start']],
    ]);
  });
});
