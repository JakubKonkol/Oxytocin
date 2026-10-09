import { describe, expect, it } from 'vitest';
import {
  allDescriptors,
  filterDescriptors,
  type PluginConfiguration,
  sectionsOf,
  settingsProblems,
  validateValue,
  valueOf,
} from './settings-model';

const plugins: PluginConfiguration[] = [
  {
    pluginId: 'z.plugin',
    pluginName: 'Zeta',
    properties: { 'zeta.level': { type: 'integer' as const, minimum: 1, maximum: 5, default: 3 } },
  },
  {
    pluginId: 'a.plugin',
    pluginName: 'Alpha',
    properties: { 'alpha.on': { type: 'boolean' as const, default: true, description: 'Turns alpha on' } },
  },
];

describe('settings model', () => {
  const all = allDescriptors('linux', plugins);

  it('orders core sections first, then plugins alphabetically', () => {
    const sections = sectionsOf(all);
    expect(sections.slice(0, 2)).toEqual(['Appearance', 'Terminal']);
    expect(sections.slice(-2)).toEqual(['Alpha', 'Zeta']);
  });

  it('filters by words, and @modified keeps changed settings only', () => {
    expect(filterDescriptors(all, 'font size', {}).map((d) => d.key)).toEqual([
      'terminal.fontSize',
      'terminal.lineHeight',
      'scratchpad.fontSize',
      'editor.code.fontSize',
    ]);
    expect(filterDescriptors(all, 'alpha', {}).map((d) => d.key)).toEqual(['alpha.on']);
    const modified = filterDescriptors(all, '@modified', { 'terminal.fontSize': 15, 'git.enabled': true });
    expect(modified.map((d) => d.key)).toEqual(['terminal.fontSize']);
    expect(filterDescriptors(all, '@modified terminal', { 'terminal.fontSize': 15, 'zeta.level': 4 })).toHaveLength(1);
  });

  it('reads values with defaults and reports invalid plugin values', () => {
    const zeta = all.find((d) => d.key === 'zeta.level')!;
    expect(valueOf(zeta, {})).toBe(3);
    expect(valueOf(zeta, { 'zeta.level': 5 })).toBe(5);
    const problems = settingsProblems([{ key: 'terminal.fontSize', message: 'too big' }], plugins, { 'zeta.level': 9 });
    expect(problems.map((p) => p.key)).toEqual(['terminal.fontSize', 'zeta.level']);
    expect(validateValue(zeta, 6, plugins)).toMatch(/≤ 5/);
    expect(
      validateValue(
        all.find((d) => d.key === 'terminal.fontSize')!,
        5,
        plugins,
      ),
    ).toBeTruthy();
    expect(
      validateValue(
        all.find((d) => d.key === 'terminal.fontSize')!,
        12,
        plugins,
      ),
    ).toBeNull();
  });
});
