import { describe, expect, it } from 'vitest';
import {
  applyUserKeybindings,
  DEFAULT_KEYBINDINGS,
  findConflicts,
  type Keybinding,
  KeybindingResolver,
} from '../../lib/keybindings';
import { buildRows, chordLabel, commandsUsing, entriesForChange, worksInTerminal } from './shortcuts-model';

const ev = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('applyUserKeybindings', () => {
  const defaults: Keybinding[] = [
    { key: 'Ctrl+Shift+T', mac: 'Cmd+T', command: 'terminal.new' },
    { key: 'Ctrl+Shift+W', mac: 'Cmd+W', command: 'panel.close' },
    { key: 'F7', command: 'diff.nextChange', when: ['diffFocus'] },
  ];

  it('adds user bindings after the defaults so they win, with parsed when contexts', () => {
    const out = applyUserKeybindings(
      defaults,
      [{ key: 'Ctrl+Shift+W', command: 'terminal.new', when: '!inputFocus' }],
      'win32',
    );
    expect(out.at(-1)).toMatchObject({ command: 'terminal.new', notWhen: ['inputFocus'], source: 'user' });
    const r = new KeybindingResolver(out, 'win32');
    expect(r.resolve(ev('KeyW', { ctrlKey: true, shiftKey: true }), 'global')?.command).toBe('terminal.new');
    expect(r.shortcutFor('terminal.new')).toBe('ctrl+shift+w');
  });

  it('removes all defaults of a command or only the one with the given key', () => {
    expect(applyUserKeybindings(defaults, [{ command: '-terminal.new' }], 'win32').map((b) => b.command)).toEqual([
      'panel.close',
      'diff.nextChange',
    ]);
    expect(applyUserKeybindings(defaults, [{ command: '-panel.close', key: 'Ctrl+Shift+X' }], 'win32')).toHaveLength(3);
    expect(applyUserKeybindings(defaults, [{ command: '-panel.close', key: 'cmd+w' }], 'darwin')).toHaveLength(2);
  });

  it('keeps defaults intact without user entries', () => {
    expect(applyUserKeybindings(DEFAULT_KEYBINDINGS, [], 'linux')).toEqual(DEFAULT_KEYBINDINGS);
  });
});

describe('findConflicts', () => {
  it('reports chords used by different commands in overlapping contexts only', () => {
    const bindings: Keybinding[] = [
      { key: 'Ctrl+Shift+F', command: 'terminal.find', when: ['terminalFocus'] },
      { key: 'Ctrl+Shift+F', command: 'changes.filter', when: ['changesFocus'] },
      { key: 'Ctrl+Shift+K', command: 'terminal.clear' },
      { key: 'Ctrl+Shift+K', command: 'my.command', notWhen: ['diffFocus'] },
      { key: 'F7', command: 'x' },
      { key: 'F7', command: 'x', when: ['diffFocus'] },
    ];
    const conflicts = findConflicts(bindings, 'win32');
    expect(conflicts.map((c) => [c.chord, c.bindings.map((b) => b.command)])).toEqual([
      ['ctrl+shift+k', ['terminal.clear', 'my.command']],
    ]);
    expect(findConflicts(bindings, 'win32', (c) => c !== 'my.command')).toEqual([]);
  });

  it('finds no conflicts in the default keymap', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(findConflicts(DEFAULT_KEYBINDINGS, platform)).toEqual([]);
    }
  });
});

describe('shortcut editor model', () => {
  const commands = [
    { id: 'terminal.new', title: 'Terminal: New Terminal' },
    { id: 'terminal.clear', title: 'Terminal: Clear' },
    { id: 'view.nothing', title: 'View: Unbound' },
  ];
  const effective = applyUserKeybindings(
    [
      { key: 'Ctrl+Shift+T', command: 'terminal.new' },
      { key: 'Ctrl+Shift+K', command: 'terminal.clear', when: ['terminalFocus'] },
      { key: 'Ctrl+Alt+1', command: 'projects.activateIndex', args: [0] },
    ],
    [{ key: 'Ctrl+Shift+K', command: 'terminal.new', when: 'terminalFocus' }],
    'win32',
  );

  it('builds sorted rows with sources, contexts and conflicts', () => {
    const rows = buildRows(
      commands,
      effective,
      [{ key: 'Ctrl+Shift+K', command: 'terminal.new' }],
      'win32',
      () => true,
    );
    expect(rows.map((r) => r.command)).toEqual(['terminal.clear', 'terminal.new', 'view.nothing']);
    const clear = rows[0]!;
    expect(clear.bindings).toEqual([
      { chord: 'ctrl+shift+k', when: 'terminalFocus', source: 'default', conflicts: ['Terminal: New Terminal'] },
    ]);
    expect(clear.customized).toBe(false);
    const created = rows[1]!;
    expect(created.customized).toBe(true);
    expect(created.bindings.map((b) => [b.chord, b.source])).toEqual([
      ['ctrl+shift+t', 'default'],
      ['ctrl+shift+k', 'user'],
    ]);
    expect(rows[2]!.bindings).toEqual([]);
  });

  it('writes a removal of the defaults plus the new chord', () => {
    expect(entriesForChange('terminal.new', 'ctrl+alt+n', undefined, true)).toEqual([
      { command: '-terminal.new' },
      { key: 'Ctrl+Alt+N', command: 'terminal.new' },
    ]);
    expect(entriesForChange('x', 'shift+f7', 'diffFocus', false)).toEqual([
      { key: 'Shift+F7', command: 'x', when: 'diffFocus' },
    ]);
    expect(chordLabel('cmd+shift+=')).toBe('Cmd+Shift+=');
    expect(chordLabel('ctrl+enter')).toBe('Ctrl+Enter');
  });

  it('lists other commands using a chord and flags chords terminals keep', () => {
    expect(commandsUsing('Ctrl+Shift+K', 'terminal.new', effective, 'win32', (id) => id)).toEqual(['terminal.clear']);
    expect(worksInTerminal('ctrl+b')).toBe(false);
    expect(worksInTerminal('ctrl+shift+b')).toBe(true);
  });
});
