import { describe, expect, it, vi } from 'vitest';
import { currentTheme, expandHex, installThemeController, onDidChangeTheme, setThemeSetting } from './theme';

function fakeWindow(dark: boolean) {
  let listener: (() => void) | undefined;
  const query = {
    matches: dark,
    addEventListener: (_: string, l: () => void) => {
      listener = l;
    },
  };
  const win = { document, matchMedia: () => query } as unknown as Window;
  return {
    win,
    setOs(next: boolean) {
      query.matches = next;
      listener?.();
    },
  };
}

describe('theme controller', () => {
  it('follows the OS until a setting is known, then the explicit setting; "system" follows the OS again', () => {
    const os = fakeWindow(false);
    const changes = vi.fn();
    const off = onDidChangeTheme(changes);
    installThemeController(os.win);
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(currentTheme()).toBe('light');
    setThemeSetting('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    os.setOs(false);
    expect(currentTheme()).toBe('dark');
    setThemeSetting('system');
    expect(currentTheme()).toBe('light');
    os.setOs(true);
    expect(currentTheme()).toBe('dark');
    // Unchanged theme: no notification.
    setThemeSetting('dark');
    expect(changes.mock.calls.map((c) => c[0] as string)).toEqual(['light', 'dark', 'light', 'dark']);
    off();
  });
});

describe('expandHex', () => {
  it('expands short hex colors for Monaco and leaves others alone', () => {
    expect(expandHex('#fff')).toBe('#ffffff');
    expect(expandHex('#0a0b')).toBe('#00aa00bb');
    expect(expandHex('#123456')).toBe('#123456');
    expect(expandHex('rgb(1 2 3)')).toBe('rgb(1 2 3)');
  });
});
