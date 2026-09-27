import { z } from 'zod';

/** Where keyboard focus is. */
export const KEY_CONTEXTS = [
  'terminalFocus',
  'sidebarFocus',
  'changesFocus',
  'diffFocus',
  'pluginViewFocus',
  'inputFocus',
  'global',
] as const;
export type KeyContext = (typeof KEY_CONTEXTS)[number];

/** One entry of userData/keybindings.json (VS Code style). `command: "-id"` removes a default binding. */
export const UserKeybindingSchema = z.object({
  /** Chord for this machine, e.g. "Ctrl+Shift+T" (on macOS "Cmd+T"). Optional only for removals. */
  key: z.string().trim().min(1).max(100).optional(),
  command: z.string().trim().min(1).max(200),
  args: z.array(z.unknown()).max(20).optional(),
  /** "terminalFocus", "!terminalFocus", "diffFocus || changesFocus" or "!inputFocus && !terminalFocus". */
  when: z.string().trim().max(300).optional(),
});
export type UserKeybinding = z.infer<typeof UserKeybindingSchema>;

export interface KeybindingProblem {
  /** Index of the entry in the file array; -1 for the whole file. */
  index: number;
  message: string;
}

export const KeybindingProblemSchema = z.object({ index: z.number().int(), message: z.string() });

export const KeybindingsStateSchema = z.object({
  path: z.string(),
  entries: z.array(UserKeybindingSchema),
  problems: z.array(KeybindingProblemSchema),
});
export type KeybindingsState = z.infer<typeof KeybindingsStateSchema>;

export type ParsedWhen = { when?: KeyContext[]; notWhen?: KeyContext[] };

const isContext = (v: string): v is KeyContext => (KEY_CONTEXTS as readonly string[]).includes(v);

/**
 * Parses the small `when` language: one context, alternatives joined by `||`, or negations joined by `&&`
 * (focus contexts are exclusive, so a conjunction of positive contexts could never match).
 */
export function parseWhen(expr: string | undefined): ParsedWhen | { error: string } {
  const text = expr?.trim();
  if (!text) return {};
  const hasOr = text.includes('||');
  const hasAnd = text.includes('&&');
  if (hasOr && hasAnd) return { error: 'Use either "||" between contexts or "&&" between negations, not both' };
  const parts = text.split(hasOr ? '||' : '&&').map((p) => p.trim());
  const when: KeyContext[] = [];
  const notWhen: KeyContext[] = [];
  for (const part of parts) {
    const negated = part.startsWith('!');
    const name = negated ? part.slice(1).trim() : part;
    if (!isContext(name)) return { error: `Unknown context "${name}" (known: ${KEY_CONTEXTS.join(', ')})` };
    (negated ? notWhen : when).push(name);
  }
  if (hasOr && notWhen.length > 0) return { error: 'Negations cannot be combined with "||"' };
  if (hasAnd && when.length > 0) return { error: 'Only negations can be combined with "&&"' };
  return { ...(when.length ? { when } : {}), ...(notWhen.length ? { notWhen } : {}) };
}

/** Formats contexts back into the `when` language. */
export function formatWhen(parsed: ParsedWhen): string | undefined {
  if (parsed.when?.length) return parsed.when.join(' || ');
  if (parsed.notWhen?.length) return parsed.notWhen.map((c) => `!${c}`).join(' && ');
  return undefined;
}

/** Validates the parsed file entry by entry: invalid entries are skipped and reported, the rest apply. */
export function resolveUserKeybindings(raw: unknown): { entries: UserKeybinding[]; problems: KeybindingProblem[] } {
  if (raw === undefined || raw === null) return { entries: [], problems: [] };
  if (!Array.isArray(raw)) return { entries: [], problems: [{ index: -1, message: 'The file must contain an array' }] };
  const entries: UserKeybinding[] = [];
  const problems: KeybindingProblem[] = [];
  raw.forEach((item, index) => {
    const parsed = UserKeybindingSchema.safeParse(item);
    if (!parsed.success) {
      problems.push({
        index,
        message: parsed.error.issues.map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`).join('; '),
      });
      return;
    }
    const entry = parsed.data;
    if (!entry.command.startsWith('-') && !entry.key) {
      problems.push({ index, message: `"key" is required for ${entry.command}` });
      return;
    }
    const when = parseWhen(entry.when);
    if ('error' in when) {
      problems.push({ index, message: when.error });
      return;
    }
    entries.push(entry);
  });
  return { entries, problems };
}
