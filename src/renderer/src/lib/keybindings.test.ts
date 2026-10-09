import { describe, expect, it } from 'vitest';
import {
  chordFromEvent,
  DEFAULT_KEYBINDINGS,
  isAllowedInTerminal,
  KeybindingResolver,
  keyNameFromCode,
  normalizeChord,
} from './keybindings';

const ev = (code: string, mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe('chords', () => {
  it('normalizes chord strings', () => {
    expect(normalizeChord('Shift+Ctrl+B')).toBe('ctrl+shift+b');
    expect(normalizeChord('Alt+Shift+=')).toBe('alt+shift+=');
    expect(normalizeChord('Ctrl+-')).toBe('ctrl+-');
    expect(normalizeChord('Cmd+Option+Left')).toBe('alt+cmd+left');
  });

  it('builds chords from physical keys', () => {
    expect(keyNameFromCode('KeyB')).toBe('b');
    expect(keyNameFromCode('Digit3')).toBe('3');
    expect(keyNameFromCode('Equal')).toBe('=');
    expect(keyNameFromCode('ShiftLeft')).toBeNull();
    expect(chordFromEvent(ev('KeyB', { ctrl: true, shift: true }))).toBe('ctrl+shift+b');
  });

  it('only lets modifier-heavy chords through in terminals', () => {
    expect(isAllowedInTerminal('ctrl+b')).toBe(false);
    expect(isAllowedInTerminal('ctrl+shift+b')).toBe(true);
    expect(isAllowedInTerminal('alt+shift+=')).toBe(true);
    expect(isAllowedInTerminal('ctrl+alt+1')).toBe(true);
    expect(isAllowedInTerminal('alt+left')).toBe(false);
    expect(isAllowedInTerminal('f7')).toBe(true);
    expect(isAllowedInTerminal('cmd+t')).toBe(true);
  });
});

describe('KeybindingResolver', () => {
  const winResolver = new KeybindingResolver(DEFAULT_KEYBINDINGS, 'win32');

  it('resolves Windows chords and args', () => {
    expect(winResolver.resolve(ev('KeyB', { ctrl: true, shift: true }), 'global')?.command).toBe(
      'workbench.toggleSidebar',
    );
    const project = winResolver.resolve(ev('Digit3', { ctrl: true, alt: true }), 'global');
    expect(project).toMatchObject({ command: 'projects.activateIndex', args: [2] });
  });

  it('never steals plain Ctrl+letter from terminals', () => {
    expect(winResolver.resolve(ev('KeyB', { ctrl: true }), 'terminalFocus')).toBeNull();
    expect(winResolver.resolve(ev('KeyR', { ctrl: true }), 'terminalFocus')).toBeNull();
    expect(winResolver.resolve(ev('ArrowLeft', { alt: true }), 'global')?.command).toBe('panel.focusLeft');
    // Explicit exception from the plan: Alt+arrows move focus between panels even from a terminal.
    expect(winResolver.resolve(ev('ArrowLeft', { alt: true }), 'terminalFocus')?.command).toBe('panel.focusLeft');
  });

  it('honours when/notWhen', () => {
    expect(winResolver.resolve(ev('KeyC', { ctrl: true, shift: true }), 'terminalFocus')?.command).toBe(
      'terminal.copy',
    );
    expect(winResolver.resolve(ev('KeyC', { ctrl: true, shift: true }), 'global')).toBeNull();
    expect(winResolver.resolve(ev('Equal', { ctrl: true }), 'global')?.command).toBe('workbench.zoomIn');
  });

  it('leaves Alt+arrows to the code editor (move lines) and keeps them for panels elsewhere', () => {
    expect(winResolver.resolve(ev('ArrowUp', { alt: true }), 'editorFocus')).toBeNull();
    expect(winResolver.resolve(ev('ArrowUp', { alt: true, shift: true }), 'editorFocus')).toBeNull();
    expect(winResolver.resolve(ev('ArrowUp', { alt: true }), 'diffFocus')?.command).toBe('panel.focusUp');
    expect(winResolver.resolve(ev('KeyP', { ctrl: true, shift: true }), 'editorFocus')?.command).toBe(
      'workbench.commandPalette',
    );
  });

  it('uses macOS chords on darwin', () => {
    const mac = new KeybindingResolver(DEFAULT_KEYBINDINGS, 'darwin');
    expect(mac.resolve(ev('KeyB', { meta: true, shift: true }), 'global')?.command).toBe('workbench.toggleSidebar');
    expect(mac.resolve(ev('KeyF', { meta: true }), 'terminalFocus')?.command).toBe('terminal.find');
  });

  it('skips bindings of unavailable commands', () => {
    const r = new KeybindingResolver(DEFAULT_KEYBINDINGS, 'win32', (c) => c !== 'workbench.toggleSidebar');
    expect(r.resolve(ev('KeyB', { ctrl: true, shift: true }), 'global')).toBeNull();
  });
});
