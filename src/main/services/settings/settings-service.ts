import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Platform } from '@shared/domain/terminal-profile';
import { resolveSettings, type Settings, type SettingsProblem } from '@shared/domain/settings';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { readJsonFile, readJsonFileSync, type ReadStatus } from '../storage/json-file-store';

export interface SettingsLoadInfo {
  status: ReadStatus;
  corruptPath?: string;
}

/**
 * Owns settings.json (JSONC). Loads synchronously at startup, validates key by key and reloads on
 * external edits. Writing from the UI arrives with the settings UI (M7).
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

  async reload(): Promise<void> {
    const result = await readJsonFile(this.filePath, { jsonc: true });
    const before = JSON.stringify(this.settings);
    this.apply(result.value, result.status, result.corruptPath);
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
