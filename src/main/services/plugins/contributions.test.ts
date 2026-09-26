import { describe, expect, it } from 'vitest';
import type { Contributions } from '@shared/domain/plugin';
import { EMPTY_CONTRIBUTIONS } from './discovery';
import { compilePluginAgentRules, configDefaults, pluginTerminalProfiles, validateConfigValue } from './contributions';

const contributions = (patch: Partial<Contributions>): Contributions => ({
  ...structuredClone(EMPTY_CONTRIBUTIONS),
  ...patch,
});

describe('plugin contributions', () => {
  it('maps terminal profiles (agents are typed into the default shell)', () => {
    const profiles = pluginTerminalProfiles(
      contributions({
        terminalProfiles: [
          {
            pluginId: 'p',
            id: 'aider-sonnet',
            name: 'Aider (Sonnet)',
            kind: 'agent',
            command: 'aider',
            args: ['--model', 'sonnet'],
          },
          { pluginId: 'p', id: 'nu', name: 'Nushell', kind: 'shell', command: 'nu', args: [] },
        ],
      }),
    );
    expect(profiles).toEqual([
      {
        id: 'aider-sonnet',
        name: 'Aider (Sonnet)',
        kind: 'agent',
        file: '',
        args: [],
        source: 'plugin',
        command: 'aider --model sonnet',
      },
      { id: 'nu', name: 'Nushell', kind: 'shell', file: 'nu', args: [], source: 'plugin' },
    ]);
  });

  it('compiles agent rules case-insensitively and skips invalid patterns', () => {
    const [rule] = compilePluginAgentRules(
      contributions({
        agents: [
          {
            pluginId: 'p',
            id: 'goose',
            displayName: 'Goose',
            provider: 'other',
            processNames: ['goose'],
            commandLinePatterns: ['GOOSE-cli', '('],
            icon: 'agent',
          },
        ],
      }),
    );
    expect(rule!.commandLinePatterns).toHaveLength(1);
    expect(rule!.commandLinePatterns![0]!.test('node /x/goose-CLI/index.js')).toBe(true);
  });

  it('validates configuration values and collects defaults', () => {
    expect(validateConfigValue('a', { type: 'boolean' }, true)).toBeNull();
    expect(validateConfigValue('a', { type: 'boolean' }, 'yes')).toMatch(/type boolean/);
    expect(validateConfigValue('a', { type: 'integer', minimum: 1, maximum: 5 }, 2.5)).toMatch(/integer/);
    expect(validateConfigValue('a', { type: 'integer', minimum: 1, maximum: 5 }, 9)).toMatch(/≤ 5/);
    expect(validateConfigValue('a', { type: 'string', enum: ['x', 'y'] }, 'z')).toMatch(/one of/);
    expect(validateConfigValue('a', { type: 'object' }, [])).toMatch(/type object/);
    expect(
      configDefaults(
        contributions({
          configuration: [
            {
              pluginId: 'p',
              prefix: 'u',
              properties: { 'u.a': { type: 'number', default: 3 }, 'u.b': { type: 'string' } },
            },
          ],
        }),
      ),
    ).toEqual({ 'u.a': 3 });
  });
});
