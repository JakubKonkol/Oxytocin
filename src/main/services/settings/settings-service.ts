import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { applyEdits, modify } from 'jsonc-parser';
import { basename, dirname } from 'node:path';
import type { Platform } from '@shared/domain/terminal-profile';
import { resolveSettings, type Settings, type SettingsProblem } from '@shared/domain/settings';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { writeFileAtomic } from '../storage/atomic-write';
import { parseJsonText, readJsonFileSync, type ReadStatus } from '../storage/json-file-store';

export interface SettingsLoadInfo {
  status: ReadStatus;
  corruptPath?: string;
}

/**
 * Owns settings.json (JSONC). Loads synchronously at startup, validates key by key and reloads on
 * external edits; the settings UI (M7-T3) writes through `update`.
 */
export class SettingsService implements Disposable {
  private settings: Settings;
  private _problems: SettingsProblem[] = [];
  private _loadInfo: SettingsLoadInfo = { status: 'missing' };
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changeEmitter = new Emitter<Settings>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly filePath: string,
    private readonly platform: Platform,
    private readonly logger: Logger,
  ) {
    this.settings = resolveSettings(undefined, platform).settings;
  }

  get problems(): readonly SettingsProblem[] {
    return this._problems;
  }

  get loadInfo(): SettingsLoadInfo {
    return this._loadInfo;
  }

  get(): Settings {
    return this.settings;
  }

  /** Startup load (the only synchronous file I/O allowed in main). */
  loadSync(): Settings {
    const result = readJsonFileSync(this.filePath, { jsonc: true });
    this.apply(result.value, result.status, result.corruptPath);
    return this.settings;
  }

  /**
   * Re-reads settings.json while the app runs. Unlike the startup load, a file that does not parse is never
   * moved aside: the user (or an editor writing in several steps) is editing it, so the last valid settings stay.
   */
  async reload(): Promise<void> {
    let text: string | null;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      text = null;
    }
    let raw: unknown;
    try {
      raw = text === null ? undefined : parseJsonText(text, true);
    } catch (e) {
      this.logger.warn('settings.json does not parse; keeping the last valid settings', e);
      return;
    }
    const before = JSON.stringify(this.settings);
    this.apply(raw, text === null ? 'missing' : 'ok', undefined);
    if (JSON.stringify(this.settings) !== before) this.changeEmitter.fire(this.settings);
  }

  private apply(raw: unknown, status: ReadStatus, corruptPath: string | undefined): void {
    this._loadInfo = corruptPath ? { status, corruptPath } : { status };
    if (corruptPath) this.logger.warn(`settings.json could not be parsed; moved to ${corruptPath}`);
    const { settings, problems } = resolveSettings(raw, this.platform);
    this.settings = settings;
    this._problems = problems;
    for (const p of problems) this.logger.warn(`Invalid setting "${p.key}": ${p.message}`);
  }

  /**
   * Writes keys into settings.json with minimal JSONC edits (comments and formatting are kept);
   * `null` removes a key. Returns the reloaded settings.
   */
  async update(patch: Record<string, unknown>): Promise<Settings> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      text = '{\n}\n';
    }
    for (const [key, value] of Object.entries(patch)) {
      const edits = modify(text, [key], value === null ? undefined : value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
      });
      text = applyEdits(text, edits);
    }
    await writeFileAtomic(this.filePath, text);
    await this.reload();
    return this.settings;
  }

  /** Creates an empty settings.json when missing ("Open settings.json"). */
  async ensureFile(): Promise<string> {
    try {
      await readFile(this.filePath, 'utf8');
    } catch {
      await writeFileAtomic(this.filePath, '{\n}\n');
    }
    return this.filePath;
  }

  /** Watches the settings directory (the file may not exist yet or be replaced atomically). */
  watch(): void {
    if (this.watcher) return;
    const name = basename(this.filePath);
    try {
      this.watcher = watch(dirname(this.filePath), (_event, file) => {
        if (file !== null && file !== name) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reload().catch((e: unknown) => this.logger.error('Failed to reload settings', e));
        }, 150);
      });
      this.watcher.on('error', (e) => this.logger.warn('Settings watcher error', e));
    } catch (e) {
      this.logger.warn('Cannot watch settings.json', e);
    }
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.changeEmitter.dispose();
  }
}
