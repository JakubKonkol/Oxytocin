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
