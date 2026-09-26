import type { UiPlatform } from './platform';

export type KeyContext =
  'terminalFocus' | 'sidebarFocus' | 'changesFocus' | 'diffFocus' | 'pluginViewFocus' | 'inputFocus' | 'global';

export interface Keybinding {
  /** Windows/Linux chord, e.g. "Ctrl+Shift+B". */
  key: string;
  /** macOS chord, e.g. "Cmd+Shift+B" (defaults to `key`). */
  mac?: string;
  command: string;
  args?: unknown[];
  /** Contexts where the binding applies (default: everywhere except text inputs). */
  when?: KeyContext[];
  /** Contexts where the binding never applies. */
  notWhen?: KeyContext[];
  /** Also intercept in terminals although the chord is not in the terminal-safe set. */
  allowInTerminal?: boolean;
}

/** Default keymap (docs/plan/02-ui-ux.md §7). Bindings for unregistered commands are ignored. */
export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: 'Ctrl+Shift+P', mac: 'Cmd+Shift+P', command: 'workbench.commandPalette' },
  { key: 'Ctrl+Shift+O', mac: 'Cmd+Shift+O', command: 'workbench.quickOpen' },
  { key: 'Ctrl+Shift+T', mac: 'Cmd+T', command: 'terminal.new' },
  { key: 'Ctrl+Shift+N', mac: 'Cmd+Shift+N', command: 'terminal.newWithProfile' },
  { key: 'Alt+Shift+=', mac: 'Cmd+D', command: 'terminal.splitRight' },
  { key: 'Alt+Shift+-', mac: 'Cmd+Shift+D', command: 'terminal.splitDown' },
  { key: 'Ctrl+Shift+W', mac: 'Cmd+W', command: 'panel.close' },
  { key: 'Alt+Left', mac: 'Alt+Cmd+Left', command: 'panel.focusLeft', allowInTerminal: true },
  { key: 'Alt+Right', mac: 'Alt+Cmd+Right', command: 'panel.focusRight', allowInTerminal: true },
  { key: 'Alt+Up', mac: 'Alt+Cmd+Up', command: 'panel.focusUp', allowInTerminal: true },
  { key: 'Alt+Down', mac: 'Alt+Cmd+Down', command: 'panel.focusDown', allowInTerminal: true },
  { key: 'Alt+Shift+Left', mac: 'Ctrl+Cmd+Left', command: 'panel.resizeLeft' },
  { key: 'Alt+Shift+Right', mac: 'Ctrl+Cmd+Right', command: 'panel.resizeRight' },
  { key: 'Alt+Shift+Up', mac: 'Ctrl+Cmd+Up', command: 'panel.resizeUp' },
  { key: 'Alt+Shift+Down', mac: 'Ctrl+Cmd+Down', command: 'panel.resizeDown' },
  { key: 'Ctrl+Shift+Enter', mac: 'Cmd+Shift+Enter', command: 'panel.toggleMaximize' },
  { key: 'Ctrl+Tab', mac: 'Ctrl+Tab', command: 'panel.nextTab' },
  { key: 'Ctrl+Shift+Tab', mac: 'Ctrl+Shift+Tab', command: 'panel.previousTab' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    key: `Ctrl+Alt+${n}`,
    mac: `Ctrl+Cmd+${n}`,
    command: 'projects.activateIndex',
    args: [n - 1],
  })),
  { key: 'Ctrl+Alt+Down', mac: 'Ctrl+Cmd+Down', command: 'projects.next' },
  { key: 'Ctrl+Alt+Up', mac: 'Ctrl+Cmd+Up', command: 'projects.previous' },
  { key: 'Ctrl+Shift+J', mac: 'Cmd+Shift+J', command: 'agents.jumpToWaiting' },
  { key: 'Ctrl+Shift+E', mac: 'Cmd+Shift+E', command: 'workbench.focusProjects' },
  { key: 'Ctrl+Shift+G', mac: 'Ctrl+Shift+G', command: 'workbench.focusChanges' },
  { key: 'Ctrl+Shift+`', mac: 'Cmd+Shift+`', command: 'workbench.focusCenter' },
  { key: 'Ctrl+Shift+B', mac: 'Cmd+Shift+B', command: 'workbench.toggleSidebar' },
  { key: 'Ctrl+Shift+F', mac: 'Cmd+F', command: 'terminal.find', when: ['terminalFocus'] },
  { key: 'Ctrl+Shift+C', mac: 'Cmd+C', command: 'terminal.copy', when: ['terminalFocus'] },
  { key: 'Ctrl+Shift+V', mac: 'Cmd+V', command: 'terminal.paste', when: ['terminalFocus'] },
  { key: 'Ctrl+Shift+K', mac: 'Cmd+K', command: 'terminal.clear', when: ['terminalFocus'] },
  { key: 'Ctrl+Shift+=', mac: 'Cmd+Shift+=', command: 'terminal.fontZoomIn' },
  { key: 'Ctrl+Shift+-', mac: 'Cmd+Shift+-', command: 'terminal.fontZoomOut' },
  { key: 'Ctrl+=', mac: 'Cmd+=', command: 'workbench.zoomIn', notWhen: ['terminalFocus'] },
  { key: 'Ctrl+-', mac: 'Cmd+-', command: 'workbench.zoomOut', notWhen: ['terminalFocus'] },
  { key: 'Ctrl+0', mac: 'Cmd+0', command: 'workbench.zoomReset', notWhen: ['terminalFocus'] },
  { key: 'Ctrl+Shift+A', mac: 'Cmd+Shift+A', command: 'projects.add', notWhen: ['terminalFocus'] },
  { key: 'F7', command: 'diff.nextChange', when: ['diffFocus'] },
  { key: 'Shift+F7', command: 'diff.previousChange', when: ['diffFocus'] },
];

const CODE_NAMES: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Space: 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Insert: 'insert',
};

/** Physical key name from KeyboardEvent.code (layout-independent: "KeyB" → "b", "Digit1" → "1"). */
export function keyNameFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  return CODE_NAMES[code] ?? null;
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'] as const;
const ALIASES: Record<string, string> = {
  control: 'ctrl',
  option: 'alt',
  meta: 'cmd',
  command: 'cmd',
  win: 'cmd',
  plus: '=',
};

/** Normalizes a chord string: "Shift+Ctrl+B" → "ctrl+shift+b". */
export function normalizeChord(chord: string): string {
  const parts = chord
    .split(/\+(?!$)/)
    .map((p) => p.trim().toLowerCase())
    .map((p) => ALIASES[p] ?? p);
  const key = parts.filter((p) => !(MODIFIER_ORDER as readonly string[]).includes(p)).join('+');
  const mods = MODIFIER_ORDER.filter((m) => parts.includes(m));
  return [...mods, key].join('+');
}

export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function chordFromEvent(e: KeyEventLike): string | null {
  const key = keyNameFromCode(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('cmd');
  return [...mods, key].join('+');
}

/**
 * Shells and agents own plain Ctrl+<letter> (Claude Code uses Ctrl+B/O/R/T/J/L…). In a focused terminal
 * the app only intercepts Ctrl+Shift, Alt+Shift, Ctrl+Alt, Cmd (macOS) and function keys.
 */
export function isAllowedInTerminal(chord: string): boolean {
  const parts = chord.split('+');
  const key = parts.at(-1) ?? '';
  const has = (m: string) => parts.includes(m);
  if (/^f\d{1,2}$/.test(key)) return true;
  if (has('cmd')) return true;
  if (has('ctrl') && has('shift')) return true;
  if (has('alt') && has('shift')) return true;
  if (has('ctrl') && has('alt')) return true;
  // Ctrl+Tab / Ctrl+Shift+Tab (tab switching) never reach shells meaningfully.
  return has('ctrl') && key === 'tab';
}

export class KeybindingResolver {
  private readonly byChord = new Map<string, Keybinding[]>();

  constructor(
    bindings: readonly Keybinding[],
    private readonly platform: UiPlatform,
    private readonly isAvailable: (command: string) => boolean = () => true,
  ) {
    for (const b of bindings) {
      const chord = normalizeChord(platform === 'darwin' ? (b.mac ?? b.key) : b.key);
      const list = this.byChord.get(chord) ?? [];
      list.push(b);
      this.byChord.set(chord, list);
    }
  }

  resolve(e: KeyEventLike, context: KeyContext): Keybinding | null {
    const chord = chordFromEvent(e);
    if (!chord) return null;
    const terminalSafe = isAllowedInTerminal(chord);
    const candidates = this.byChord.get(chord) ?? [];
    // Later bindings (user overrides in M7) win.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const b = candidates[i]!;
      if (!this.isAvailable(b.command)) continue;
      if (context === 'terminalFocus' && !terminalSafe && !b.allowInTerminal) continue;
      if (b.when && !b.when.includes(context)) continue;
      if (b.notWhen?.includes(context)) continue;
      if (context === 'inputFocus' && !b.when?.includes('inputFocus') && !/ctrl|cmd|alt/.test(chord)) continue;
      return b;
    }
    return null;
  }

  /** The display chord of the first binding for a command (tooltips, menus). */
  shortcutFor(command: string): string | undefined {
    for (const [chord, list] of this.byChord) {
      if (list.some((b) => b.command === command)) return chord;
    }
    return undefined;
  }
}
