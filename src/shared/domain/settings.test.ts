import { describe, expect, it } from 'vitest';
import { defaultSettings, resolveSettings } from './settings';

describe('settings', () => {
  it('uses platform-specific defaults', () => {
    expect(defaultSettings('win32')['terminal.rightClickBehavior']).toBe('copyPaste');
    expect(defaultSettings('linux')['terminal.rightClickBehavior']).toBe('menu');
    expect(defaultSettings('darwin')['terminal.fontFamily']).toMatch(/^SF Mono/);
  });

  it('falls back to defaults for invalid values and reports a problem', () => {
    const { settings, problems } = resolveSettings(
      { 'terminal.fontSize': 400, 'terminal.cursorStyle': 'block' },
      'win32',
    );
    expect(settings['terminal.fontSize']).toBe(13);
    expect(settings['terminal.cursorStyle']).toBe('block');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.key).toBe('terminal.fontSize');
  });

  it('keeps unknown keys', () => {
    const { settings } = resolveSettings({ 'usage.budget.daily': 10 }, 'linux');
    expect(settings['usage.budget.daily']).toBe(10);
  });

  it('migrates renamed keys', () => {
    const { settings } = resolveSettings({ 'terminal.rendererType': 'webgl' }, 'linux');
    expect(settings['terminal.renderer']).toBe('webgl');
    expect('terminal.rendererType' in settings).toBe(false);
  });

  it('rejects non-object roots', () => {
    const { problems } = resolveSettings([1, 2], 'linux');
    expect(problems).toHaveLength(1);
  });

  it('returns fresh default objects', () => {
    const a = defaultSettings('linux');
    a['git.ignoredFolders'].push('x');
    expect(defaultSettings('linux')['git.ignoredFolders']).not.toContain('x');
  });
});
