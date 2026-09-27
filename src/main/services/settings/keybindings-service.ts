import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from 'jsonc-parser';
import {
  type KeybindingProblem,
  type KeybindingsState,
  resolveUserKeybindings,
  type UserKeybinding,
} from '@shared/domain/keybindings';
import type { Logger } from '@shared/logging/logger';
import type { Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { writeFileAtomic } from '../storage/atomic-write';

const TEMPLATE = `// Keyboard shortcuts: entries here override the defaults (later entries win).
// { "key": "Ctrl+Shift+T", "command": "terminal.new" }
// { "command": "-terminal.new" } removes a default shortcut; "when": "terminalFocus" limits where it applies.
[
]
`;

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } } as const;

/**
 * Owns userData/keybindings.json (JSONC, docs/plan/09-persistence-settings.md §1). A file with syntax errors
 * is never moved aside (the user is editing it): the last valid shortcuts stay active and a problem is reported.
 */
export class KeybindingsService implements Disposable {
  private entries: UserKeybinding[] = [];
  private problems: KeybindingProblem[] = [];
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changeEmitter = new Emitter<KeybindingsState>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  get state(): KeybindingsState {
    return { path: this.filePath, entries: this.entries, problems: this.problems };
  }

  private async readText(): Promise<string | null> {
    try {
      return await readFile(this.filePath, 'utf8');
    } catch {
      return null;
    }
  }

  async load(): Promise<KeybindingsState> {
    const text = await this.readText();
    if (text === null) {
      this.entries = [];
      this.problems = [];
      return this.state;
    }
    const errors: ParseError[] = [];
    const raw: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      const first = errors[0]!;
      const line = text.slice(0, first.offset).split('\n').length;
      this.problems = [
        {
          index: -1,
          message: `Syntax error (${printParseErrorCode(first.error)}) on line ${line}; the last valid shortcuts stay active`,
        },
      ];
      this.logger.warn(`keybindings.json: ${this.problems[0]!.message}`);
      return this.state;
    }
    const resolved = resolveUserKeybindings(raw);
    this.entries = resolved.entries;
    this.problems = resolved.problems;
    for (const p of resolved.problems) this.logger.warn(`keybindings.json entry ${p.index}: ${p.message}`);
    return this.state;
  }

  private async reload(): Promise<void> {
    const before = JSON.stringify(this.state);
    await this.load();
    if (JSON.stringify(this.state) !== before) this.changeEmitter.fire(this.state);
  }

  /** Creates the file from a commented template when it does not exist (Open Keyboard Shortcuts (JSON)). */
  async ensureFile(): Promise<string> {
    if ((await this.readText()) === null) await writeFileAtomic(this.filePath, TEMPLATE);
    return this.filePath;
  }

  /**
   * Replaces the user entries of one command (its bindings and its `-command` removals) with `entries`,
   * keeping comments and every other entry. An empty list resets the command to its defaults.
   */
  async setForCommand(command: string, entries: UserKeybinding[]): Promise<KeybindingsState> {
    let text = (await this.readText()) ?? TEMPLATE;
    const errors: ParseError[] = [];
    const raw: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || (raw !== undefined && !Array.isArray(raw)))
      throw new Error('keybindings.json has errors; fix it before changing shortcuts in the editor');
    if (raw === undefined) text = TEMPLATE;
    const list = (Array.isArray(raw) ? raw : []) as unknown[];
    const matches = (item: unknown) => {
      const c = (item as { command?: unknown } | null)?.command;
      return c === command || c === `-${command}`;
    };
    for (let i = list.length - 1; i >= 0; i--) {
      if (matches(list[i])) text = applyEdits(text, modify(text, [i], undefined, FORMAT));
    }
    let length = list.filter((item) => !matches(item)).length;
    for (const entry of entries) {
      text = applyEdits(text, modify(text, [length], entry, { ...FORMAT, isArrayInsertion: true }));
      length++;
    }
    await writeFileAtomic(this.filePath, text);
    await this.reload();
    return this.state;
  }

  watch(): void {
    if (this.watcher) return;
    const name = basename(this.filePath);
    try {
      this.watcher = watch(dirname(this.filePath), (_event, file) => {
        if (file !== null && file !== name) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reload().catch((e: unknown) => this.logger.error('Failed to reload keybindings', e));
        }, 150);
      });
      this.watcher.on('error', (e) => this.logger.warn('Keybindings watcher error', e));
    } catch (e) {
      this.logger.warn('Cannot watch keybindings.json', e);
    }
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.changeEmitter.dispose();
  }
}
