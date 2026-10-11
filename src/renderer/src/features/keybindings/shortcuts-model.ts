import { formatWhen, type UserKeybinding } from '@shared/domain/keybindings';
import { chordOf, findConflicts, isAllowedInTerminal, type Keybinding, normalizeChord } from '../../lib/keybindings';
import type { UiPlatform } from '../../lib/platform';

export interface ShortcutBinding {
  /** Normalized chord ("ctrl+shift+t"). */
  chord: string;
  when?: string;
  source: 'default' | 'user';
  /** Other commands sharing the chord in an overlapping context. */
  conflicts: string[];
}

export interface ShortcutRow {
  command: string;
  title: string;
  bindings: ShortcutBinding[];
  /** keybindings.json has entries for this command (bindings or removals): "Reset" is offered. */
  customized: boolean;
}

/** "ctrl+shift+t" → "Ctrl+Shift+T" (the spelling written to keybindings.json). */
export function chordLabel(chord: string): string {
  const parts = chord.split('+');
  return parts
    .map((p, i) => {
      if (i < parts.length - 1 || ['ctrl', 'alt', 'shift', 'cmd'].includes(p)) return p[0]!.toUpperCase() + p.slice(1);
      return p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1);
    })
    .join('+');
}

/** Rows of the shortcut editor: every palette command plus any other command that has a binding. */
export function buildRows(
  commands: readonly { id: string; title: string }[],
  effective: readonly Keybinding[],
  user: readonly UserKeybinding[],
  platform: UiPlatform,
  isAvailable: (command: string) => boolean,
): ShortcutRow[] {
  const titles = new Map(commands.map((c) => [c.id, c.title]));
  const conflicts = findConflicts(effective, platform, isAvailable);
  const conflictMap = new Map<Keybinding, string[]>();
  for (const c of conflicts) {
    for (const b of c.bindings) {
      const others = c.bindings.filter((o) => o.command !== b.command).map((o) => titles.get(o.command) ?? o.command);
      conflictMap.set(b, [...new Set(others)]);
    }
  }
  const customized = new Set(user.map((e) => e.command.replace(/^-/, '')));
  const rows = new Map<string, ShortcutRow>();
  for (const c of commands)
    rows.set(c.id, { command: c.id, title: c.title, bindings: [], customized: customized.has(c.id) });
  for (const b of effective) {
    // Bindings with arguments (e.g. "open project N") belong to internal commands: edit them in keybindings.json.
    if (b.args || !isAvailable(b.command)) continue;
    const row = rows.get(b.command);
    if (!row) continue;
    const when = formatWhen({ ...(b.when ? { when: b.when } : {}), ...(b.notWhen ? { notWhen: b.notWhen } : {}) });
    row.bindings.push({
      chord: chordOf(b, platform),
      ...(when ? { when } : {}),
      source: b.source === 'user' ? 'user' : 'default',
      conflicts: conflictMap.get(b) ?? [],
    });
  }
  return [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * keybindings.json entries for "change the shortcut of `command` to `chord`": the defaults are removed (so the
 * old chord stops working) and the new chord is added.
 */
export function entriesForChange(
  command: string,
  chord: string,
  when: string | undefined,
  hasDefaults: boolean,
): UserKeybinding[] {
  return [
    ...(hasDefaults ? [{ command: `-${command}` }] : []),
    { key: chordLabel(normalizeChord(chord)), command, ...(when ? { when } : {}) },
  ];
}

/** Commands that already use a chord (recorder hint). */
export function commandsUsing(
  chord: string,
  command: string,
  effective: readonly Keybinding[],
  platform: UiPlatform,
  titleOf: (id: string) => string,
): string[] {
  const normalized = normalizeChord(chord);
  return [
    ...new Set(
      effective
        .filter((b) => b.command !== command && chordOf(b, platform) === normalized)
        .map((b) => titleOf(b.command)),
    ),
  ];
}

/** Shells and agents keep plain Ctrl+letter chords: such a shortcut never fires inside a terminal. */
export function worksInTerminal(chord: string): boolean {
  return isAllowedInTerminal(normalizeChord(chord));
}

/** One line of the keyboard shortcuts overview. */
export interface CheatSheetEntry {
  title: string;
  /** Chords ("ctrl+shift+t"; "mod" stands for Ctrl, ⌘ on macOS). */
  chords: string[];
  /** The chords are the ends of a range ("Ctrl+Alt+1 … 9"), not alternatives. */
  range?: boolean;
  /** Built in (editor, terminal, dialogs): not changed in the Keyboard Shortcuts editor. */
  fixed?: boolean;
}

export interface CheatSheetGroup {
  name: string;
  entries: CheatSheetEntry[];
}

/** Built-in shortcuts that are not commands (Monaco, the terminal key handler, dialogs). */
export function fixedShortcuts(platform: UiPlatform): (CheatSheetEntry & { group: string })[] {
  const mac = platform === 'darwin';
  return [
    { group: 'Editor and Diffs', title: 'Save the file', chords: ['mod+s'] },
    { group: 'Editor and Diffs', title: 'Find', chords: ['mod+f'] },
    { group: 'Editor and Diffs', title: 'Replace', chords: [mac ? 'cmd+alt+f' : 'ctrl+h'] },
    { group: 'Editor and Diffs', title: 'Ask an agent about the selection', chords: ['mod+l'] },
    { group: 'Editor and Diffs', title: 'Add a review comment to the selection', chords: ['mod+alt+m'] },
    { group: 'Terminal', title: 'New line in an agent prompt', chords: ['shift+enter'] },
    ...(mac
      ? []
      : [
          { group: 'Terminal', title: 'Copy Selection', chords: ['ctrl+c'] },
          { group: 'Terminal', title: 'Interrupt (without a selection)', chords: ['ctrl+c'] },
          { group: 'Terminal', title: 'Paste', chords: ['ctrl+v'] },
        ]),
    { group: 'Dialogs and Lists', title: 'Send, commit or start (message boxes)', chords: ['mod+enter'] },
    { group: 'Dialogs and Lists', title: 'Rename the selected project', chords: ['f2'] },
    { group: 'Dialogs and Lists', title: 'Close a dialog, menu or search', chords: ['escape'] },
  ].map((e) => ({ ...e, fixed: true }));
}

const GROUP_ORDER = [
  'General',
  'View',
  'Projects',
  'Terminal',
  'Agents',
  'Editor and Diffs',
  'Diff',
  'Git',
  'Review',
  'Preferences',
  'Dialogs and Lists',
];

const rank = (group: string) => {
  const i = GROUP_ORDER.indexOf(group);
  return i < 0 ? GROUP_ORDER.length : i;
};

/** "Terminal: New Terminal" → ["Terminal", "New Terminal"]. */
function splitTitle(title: string): [string, string] {
  const i = title.indexOf(': ');
  return i < 0 ? ['General', title] : [title.slice(0, i), title.slice(i + 2)];
}

/**
 * The keyboard shortcuts overview: the commands that have a shortcut grouped by their category ("View: …"), the
 * project switch shortcuts, and the built-in shortcuts; filtered by `query` (title, group or keys).
 */
export function cheatSheet(
  rows: readonly ShortcutRow[],
  effective: readonly Keybinding[],
  platform: UiPlatform,
  query = '',
): CheatSheetGroup[] {
  const entries: (CheatSheetEntry & { group: string })[] = [];
  for (const row of rows) {
    if (row.bindings.length === 0) continue;
    const [group, title] = splitTitle(row.title);
    entries.push({ group, title, chords: [...new Set(row.bindings.map((b) => b.chord))] });
  }
  const byPosition = effective
    .filter((b) => b.command === 'projects.activateIndex' && typeof b.args?.[0] === 'number')
    .sort((a, b) => (a.args![0] as number) - (b.args![0] as number));
  if (byPosition.length > 0) {
    const first = chordOf(byPosition[0]!, platform);
    const last = chordOf(byPosition.at(-1)!, platform);
    entries.push({
      group: 'Projects',
      title: `Open project 1–${byPosition.length}`,
      chords: first === last ? [first] : [first, last],
      range: true,
    });
  }
  entries.push(...fixedShortcuts(platform));

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (e: CheatSheetEntry & { group: string }) => {
    const haystack = `${e.group} ${e.title} ${e.chords.join(' ')}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  };
  const groups = new Map<string, CheatSheetEntry[]>();
  for (const { group, ...entry } of entries.filter(matches)) {
    const list = groups.get(group) ?? [];
    // A built-in chord of a command (Ctrl+V next to Ctrl+Shift+V) is listed as an alternative.
    const same = list.find((e) => e.title === entry.title && !e.range && !entry.range);
    if (same) same.chords = [...new Set([...same.chords, ...entry.chords])];
    else list.push(entry);
    groups.set(group, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, list]) => ({ name, entries: list }));
}
