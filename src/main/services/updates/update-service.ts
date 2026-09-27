import type { Settings } from '@shared/domain/settings';
import type { UpdateChannel, UpdateState } from '@shared/domain/updates';
import type { Logger } from '@shared/logging/logger';
import type { Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';

/** The update mechanism (electron-updater in packaged builds, a scripted fake in E2E). */
export interface UpdaterBackend {
  setChannel(channel: UpdateChannel): void;
  /** The newer version, or null when the app is up to date. */
  check(): Promise<{ version: string } | null>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /**
   * Starts installing the downloaded update while the app quits; `restart` launches the new version afterwards.
   * Returns true when the backend quits the app itself.
   */
  install(restart: boolean): boolean;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  /** null = updates are unavailable, for `disabledReason`. */
  backend: UpdaterBackend | null;
  disabledReason?: string;
  settings: () => Settings;
  onDidChangeSettings: (listener: (settings: Settings) => void) => Disposable;
  /** Starts the regular quit sequence (QuitGuard first). */
  requestQuit: () => void;
  logger: Logger;
  now?: () => number;
}

export const FIRST_CHECK_DELAY_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Auto-update: checks at start and every 6 hours, downloads in the
 * background and installs only when the user quits or clicks "Restart" — never an automatic restart, since
 * terminals may be running agents. A restart goes through the same QuitGuard as quitting.
 */
export class UpdateService implements Disposable {
  private state: UpdateState;
  private restartRequested = false;
  private inFlight: Promise<UpdateState> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly settingsSubscription: Disposable;
  private readonly changeEmitter = new Emitter<UpdateState>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = {
      currentVersion: options.currentVersion,
      status: 'idle',
      ...(options.backend ? {} : { disabledReason: options.disabledReason ?? 'Updates are not available.' }),
    };
    this.settingsSubscription = options.onDidChangeSettings((s) => this.schedule(s));
  }

  get(): UpdateState {
    return this.state;
  }

  /** Starts the automatic checks (when enabled in the settings). */
  start(): void {
    this.schedule(this.options.settings());
  }

  private schedule(settings: Settings): void {
    const on = this.options.backend !== null && settings['updates.checkAutomatically'];
    if (on && !this.interval) {
      this.firstTimer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
      this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    } else if (!on) {
      this.stopTimers();
    }
  }

  private stopTimers(): void {
    clearTimeout(this.firstTimer);
    clearInterval(this.interval);
    this.firstTimer = undefined;
    this.interval = undefined;
  }

  private set(next: Omit<UpdateState, 'currentVersion' | 'disabledReason'>): void {
    this.state = {
      currentVersion: this.state.currentVersion,
      ...(this.state.disabledReason ? { disabledReason: this.state.disabledReason } : {}),
      ...(this.state.lastCheck !== undefined ? { lastCheck: this.state.lastCheck } : {}),
      ...next,
    };
    this.changeEmitter.fire(this.state);
  }

  /**
   * Checks for a newer version. Resolves once the check itself is done (the download continues in the
   * background); a check while another one runs, or once an update is ready, returns the current state.
   */
  check(): Promise<UpdateState> {
    const backend = this.options.backend;
    if (!backend || this.state.status === 'ready' || this.state.status === 'downloading')
      return Promise.resolve(this.state);
    this.inFlight ??= this.runCheck(backend).finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async runCheck(backend: UpdaterBackend): Promise<UpdateState> {
    const now = this.options.now ?? Date.now;
    this.set({ status: 'checking' });
    let found: { version: string } | null;
    try {
      backend.setChannel(this.options.settings()['updates.channel']);
      found = await backend.check();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.options.logger.warn('Update check failed', error);
      this.set({ status: 'error', error, lastCheck: now() });
      return this.state;
    }
    if (!found) {
      this.set({ status: 'up-to-date', lastCheck: now() });
      return this.state;
    }
    const version = found.version;
    this.options.logger.info(`Downloading update ${version}`);
    this.set({ status: 'downloading', version, percent: 0, lastCheck: now() });
    void this.download(backend, version);
    return this.state;
  }

  private async download(backend: UpdaterBackend, version: string): Promise<void> {
    let last = 0;
    try {
      await backend.download((percent) => {
        const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
        if (rounded === last || this.state.status !== 'downloading') return;
        last = rounded;
        this.set({ status: 'downloading', version, percent: rounded });
      });
      this.options.logger.info(`Update ${version} is ready to install`);
      this.set({ status: 'ready', version });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.options.logger.warn(`Downloading update ${version} failed`, error);
      this.set({ status: 'error', error });
    }
  }

  /** "Restart to update": quits through QuitGuard; the update installs and the new version starts. */
  restartToUpdate(): boolean {
    if (this.state.status !== 'ready') return false;
    this.restartRequested = true;
    this.options.requestQuit();
    return true;
  }

  /** The user cancelled the quit (QuitGuard): the update stays ready for the next quit. */
  cancelRestart(): void {
    this.restartRequested = false;
  }

  /**
   * Last step of the quit sequence: installs a downloaded update. Returns true when the updater quits the app
   * itself (the caller must not exit first).
   */
  installOnQuit(): boolean {
    const backend = this.options.backend;
    if (!backend || this.state.status !== 'ready') return false;
    this.options.logger.info(`Installing update ${this.state.version ?? ''} (restart: ${this.restartRequested})`);
    try {
      return backend.install(this.restartRequested);
    } catch (e) {
      this.options.logger.error('Installing the update failed', e);
      return false;
    }
  }

  dispose(): void {
    this.stopTimers();
    this.settingsSubscription.dispose();
    this.changeEmitter.dispose();
  }
}
