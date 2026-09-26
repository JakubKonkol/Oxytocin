import { describe, expect, it } from 'vitest';
import { composeEnv } from '../terminals/env-composer';
import { affectedBy, pluginEnvLayers } from './plugin-env';

describe('plugin environment collections', () => {
  const contributions = [
    {
      pluginId: 'a',
      entries: [
        { op: 'replace' as const, name: 'OTEL_ENDPOINT', value: 'http://127.0.0.1:4318' },
        { op: 'replace' as const, name: 'TAG', value: 'term=${env:OXYTOCIN_TERMINAL_ID}' },
        { op: 'append' as const, name: 'PATH', value: '/plugin/bin' },
        { op: 'replace' as const, name: 'ONLY_AGENTS', value: '1', scope: { profileIds: ['agent:claude'] } },
        { op: 'replace' as const, name: 'ONLY_P2', value: '1', scope: { projectId: 'p2' } },
      ],
    },
    {
      pluginId: 'b',
      entries: [
        { op: 'prepend' as const, name: 'PATH', value: '/b/bin' },
        { op: 'delete' as const, name: 'SECRET' },
      ],
    },
  ];

  it('builds scoped layers that compose after the project layer', () => {
    const layers = pluginEnvLayers(contributions, { projectId: 'p1', profileId: 'bash' }, 'linux');
    expect(layers[0]).toEqual({
      OTEL_ENDPOINT: 'http://127.0.0.1:4318',
      TAG: 'term=${env:OXYTOCIN_TERMINAL_ID}',
      PATH: '${env:PATH}:/plugin/bin',
    });
    const env = composeEnv({
      platform: 'linux',
      base: { PATH: '/usr/bin', SECRET: 's' },
      dev: false,
      appVersion: '1',
      projectId: 'p1',
      terminalId: 't-1',
      layers: layers,
    });
    expect(env['PATH']).toBe('/b/bin:/usr/bin:/plugin/bin');
    expect(env['TAG']).toBe('term=t-1');
    expect(env['SECRET']).toBeUndefined();
    expect(env['ONLY_AGENTS']).toBeUndefined();

    const agent = pluginEnvLayers(contributions, { projectId: 'p2', profileId: 'agent:claude' }, 'win32');
    expect(agent[0]).toMatchObject({ ONLY_AGENTS: '1', ONLY_P2: '1', PATH: '${env:PATH};/plugin/bin' });
  });

  it('appends with a separator only when the variable already has a value', () => {
    const attrs = [
      {
        pluginId: 'otel',
        entries: [
          {
            op: 'append' as const,
            name: 'OTEL_RESOURCE_ATTRIBUTES',
            value: 'oxytocin.terminal_id=${env:OXYTOCIN_TERMINAL_ID}',
            separator: ',',
          },
        ],
      },
    ];
    const compose = (base: Record<string, string>) =>
      composeEnv({
        platform: 'linux',
        base,
        dev: false,
        appVersion: '1',
        projectId: 'p1',
        terminalId: 't-1',
        layers: pluginEnvLayers(attrs, { projectId: 'p1', profileId: 'bash' }, 'linux'),
      })['OTEL_RESOURCE_ATTRIBUTES'];
    expect(compose({})).toBe('oxytocin.terminal_id=t-1');
    expect(compose({ OTEL_RESOURCE_ATTRIBUTES: 'team=a' })).toBe('team=a,oxytocin.terminal_id=t-1');
  });

  it('finds affected terminals', () => {
    const c = contributions[0]!;
    expect(affectedBy(undefined, c, { projectId: 'x', profileId: 'bash' })).toBe(true);
    const scoped = {
      pluginId: 'c',
      entries: [{ op: 'replace' as const, name: 'X', value: '1', scope: { projectId: 'p2' } }],
    };
    expect(affectedBy(undefined, scoped, { projectId: 'p1', profileId: 'bash' })).toBe(false);
    expect(affectedBy(scoped, undefined, { projectId: 'p2', profileId: 'bash' })).toBe(true);
  });
});
