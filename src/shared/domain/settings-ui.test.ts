import { describe, expect, it } from 'vitest';
import { CORE_SETTING_KEYS } from './settings';
import {
  coreSettingDescriptors,
  formatSettingInput,
  isModified,
  parseSettingInput,
  pluginSettingDescriptors,
  settingTitle,
  validateConfigValue,
  validateCoreValue,
} from './settings-ui';

describe('settingTitle', () => {
  it('derives readable titles without the section segment', () => {
    expect(settingTitle('terminal.fontSize')).toBe('Font Size');
    expect(settingTitle('git.diff.sideBySide')).toBe('Diff: Side By Side');
    expect(settingTitle('appearance.uiZoom')).toBe('UI Zoom');
    expect(settingTitle('usage.pricing.autoUpdate')).toBe('Pricing: Auto Update');
  });
});

describe('coreSettingDescriptors', () => {
  it('covers every core key for the platform with a description and a control', () => {
    const win = coreSettingDescriptors('win32');
    const keys = win.map((d) => d.key);
    expect(keys).toContain('terminal.defaultProfile.windows');
    expect(keys).not.toContain('terminal.defaultProfile.osx');
    expect(keys).not.toContain('terminal.macOptionIsMeta');
    expect(coreSettingDescriptors('darwin').map((d) => d.key)).toContain('terminal.macOptionIsMeta');
    expect(win.length).toBe(CORE_SETTING_KEYS.length - 3);
    for (const d of win) expect(d.description, d.key).toBeTruthy();
  });

  it('maps schemas to controls with ranges and enum values', () => {
    const byKey = new Map(coreSettingDescriptors('linux').map((d) => [d.key, d]));
    expect(byKey.get('terminal.fontSize')).toMatchObject({ control: 'number', minimum: 8, maximum: 32, default: 13 });
    expect(byKey.get('terminal.scrollback')).toMatchObject({ control: 'integer', minimum: 1000 });
    expect(byKey.get('appearance.theme')!.enumValues!.map((e) => e.value)).toEqual(['dark', 'light', 'system']);
    expect(byKey.get('git.path')!.control).toBe('nullableString');
    expect(byKey.get('git.ignoredFolders')!.control).toBe('stringList');
    expect(byKey.get('terminal.env')!.control).toBe('json');
    expect(byKey.get('terminal.profiles')!.control).toBe('json');
    expect(byKey.get('plugins.enabled')!.readOnly).toBe(true);
    expect(byKey.get('terminal.rightClickBehavior')!.default).toBe('menu');
    expect(byKey.get('terminal.fontSize')!.section).toBe('Terminal');
  });
});

describe('plugin descriptors and validation', () => {
  const props = {
    'usage.costMode': {
      type: 'string' as const,
      enum: ['auto', 'calculate'],
      enumDescriptions: ['A', 'C'],
      default: 'auto',
    },
    'usage.retentionDays': { type: 'integer' as const, minimum: 7, default: 365, description: 'Days kept' },
    'usage.sources.claudeCode.extraDirs': { type: 'array' as const, default: [] },
  };
  it('builds descriptors in the plugin section', () => {
    const ds = pluginSettingDescriptors('oxytocin.usage-monitor', 'Usage Monitor', props);
    expect(ds.map((d) => [d.key, d.control, d.section])).toEqual([
      ['usage.costMode', 'enum', 'Usage Monitor'],
      ['usage.retentionDays', 'integer', 'Usage Monitor'],
      ['usage.sources.claudeCode.extraDirs', 'stringList', 'Usage Monitor'],
    ]);
    expect(ds[0]!.enumValues![1]).toEqual({ value: 'calculate', label: 'Calculate', description: 'C' });
    expect(ds[1]).toMatchObject({ minimum: 7, description: 'Days kept', pluginId: 'oxytocin.usage-monitor' });
  });

  it('validates plugin and core values', () => {
    expect(validateConfigValue('usage.retentionDays', props['usage.retentionDays'], 3)).toMatch(/≥ 7/);
    expect(validateConfigValue('usage.costMode', props['usage.costMode'], 'x')).toMatch(/one of/);
    expect(validateConfigValue('usage.retentionDays', props['usage.retentionDays'], 30)).toBeNull();
    expect(validateCoreValue('terminal.fontSize', 99)).toBeTruthy();
    expect(validateCoreValue('terminal.fontSize', 14)).toBeNull();
  });
});

describe('form input', () => {
  const [fontSize, gitPath, ignored, scrollback] = [
    'terminal.fontSize',
    'git.path',
    'git.ignoredFolders',
    'terminal.scrollback',
  ].map((k) => coreSettingDescriptors('linux').find((d) => d.key === k)!);
  it('parses numbers with ranges, nullable strings and lists', () => {
    expect(parseSettingInput(fontSize!, '15')).toEqual({ value: 15 });
    expect(parseSettingInput(fontSize!, '40')).toEqual({ error: 'Maximum is 32' });
    expect(parseSettingInput(fontSize!, 'abc')).toEqual({ error: 'Enter a number' });
    expect(parseSettingInput(scrollback!, '1500.5')).toEqual({ error: 'Enter a whole number' });
    expect(parseSettingInput(gitPath!, '  ')).toEqual({ value: null });
    expect(parseSettingInput(ignored!, 'a\n\n b \r\nc')).toEqual({ value: ['a', 'b', 'c'] });
  });
  it('formats values back and detects modifications', () => {
    expect(formatSettingInput(ignored!, ['a', 'b'])).toBe('a\nb');
    expect(formatSettingInput(gitPath!, null)).toBe('');
    expect(isModified(fontSize!, 13)).toBe(false);
    expect(isModified(fontSize!, 14)).toBe(true);
    expect(isModified(fontSize!, undefined)).toBe(false);
  });
});
