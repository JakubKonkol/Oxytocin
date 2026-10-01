import type { Logger } from '@shared/logging/logger';
import type { Disposable } from '@shared/utils/disposable';

export interface RendererRecoveryOptions {
  /** The window is gone (closed or destroyed): nothing to recover. */
  isDestroyed: () => boolean;
  reload: () => void;
  quit: () => void;
  /** Asked after `maxCrashes` crashes within `crashWindowMs`; the renderer is gone, so this is a native dialog. */
  askAfterCrashes: (crashes: number) => Promise<'reload' | 'quit'>;
  /**
   * Asked once the window has not responded for a while; `signal` aborts when it responds again (the dialog
   * closes and the answer is ignored).
   */
  askWhenUnresponsive: (signal: AbortSignal) => Promise<'reload' | 'wait'>;
  logger: Logger;
  /** Crashes tolerated within `crashWindowMs` before asking the user (default 3 within 60 s). */
  maxCrashes?: number;
  crashWindowMs?: number;
  /** Delay before reloading a crashed renderer (default 500 ms). */
  reloadDelayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Disposable;
}

const defaultTimer = (fn: () => void, ms: number): Disposable => {
  const handle = setTimeout(fn, ms);
  return { dispose: () => clearTimeout(handle) };
};

/**
 * Keeps the shell window usable when its renderer crashes or hangs: a crashed renderer reloads by itself (the
 * terminals, agents and hosts live in other processes and reattach), a crash loop asks the user instead of
 * reloading forever, and a hung renderer offers a reload. Without this a crash leaves a blank window.
 */
export class RendererRecovery implements Disposable {
  private readonly crashes: number[] = [];
  private pendingReload: Disposable | undefined;
  private asking = false;
  private unresponsive: AbortController | undefined;
  private disposed = false;
  private readonly o: Required<Omit<RendererRecoveryOptions, 'now' | 'setTimer'>> & {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => Disposable;
  };

  constructor(options: RendererRecoveryOptions) {
    this.o = {
      maxCrashes: 3,
      crashWindowMs: 60_000,
      reloadDelayMs: 500,
      now: () => Date.now(),
      setTimer: defaultTimer,
      ...options,
    };
  }

  /** `render-process-gone` of the window's webContents (`reason` as in Electron's RenderProcessGoneDetails). */
  onGone(details: { reason: string; exitCode: number }): void {
    if (this.disposed || this.o.isDestroyed()) return;
    // A hang dialog for the old renderer is moot now.
    this.unresponsive?.abort();
    this.unresponsive = undefined;
    if (details.reason === 'clean-exit') {
      this.o.logger.info('The window renderer exited cleanly');
      return;
    }
    this.o.logger.error(`The window renderer is gone (${details.reason}, exit code ${details.exitCode})`);
    const now = this.o.now();
    this.crashes.push(now);
    while (this.crashes.length > 0 && now - this.crashes[0]! > this.o.crashWindowMs) this.crashes.shift();
    if (this.crashes.length < this.o.maxCrashes) {
      this.scheduleReload();
      return;
    }
    if (this.asking) return;
    this.asking = true;
    const count = this.crashes.length;
    void this.o
      .askAfterCrashes(count)
      .catch((e: unknown) => {
        this.o.logger.error('Could not ask how to recover the window', e);
        return 'reload' as const;
      })
      .then((choice) => {
        this.asking = false;
        if (this.disposed || this.o.isDestroyed()) return;
        if (choice === 'quit') {
          this.o.logger.info('Quitting after repeated renderer crashes');
          this.o.quit();
          return;
        }
        this.crashes.length = 0;
        this.reloadNow();
      });
  }

  /** The window's `unresponsive` event (Electron fires it after a few seconds without a response). */
  onUnresponsive(): void {
    if (this.disposed || this.o.isDestroyed() || this.unresponsive) return;
    this.o.logger.warn('The window is not responding');
    const controller = new AbortController();
    this.unresponsive = controller;
    void this.o
      .askWhenUnresponsive(controller.signal)
      .catch((e: unknown) => {
        this.o.logger.error('Could not ask how to recover the unresponsive window', e);
        return 'wait' as const;
      })
      .then((choice) => {
        if (this.unresponsive === controller) this.unresponsive = undefined;
        if (controller.signal.aborted || this.disposed || this.o.isDestroyed()) return;
        if (choice === 'reload') {
          this.o.logger.warn('Reloading the unresponsive window');
          this.reloadNow();
        }
      });
  }

  /** The window's `responsive` event. */
  onResponsive(): void {
    if (!this.unresponsive) return;
    this.o.logger.info('The window is responding again');
    this.unresponsive.abort();
    this.unresponsive = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingReload?.dispose();
    this.pendingReload = undefined;
    this.unresponsive?.abort();
    this.unresponsive = undefined;
  }

  private scheduleReload(): void {
    this.pendingReload?.dispose();
    this.pendingReload = this.o.setTimer(() => {
      this.pendingReload = undefined;
      if (this.disposed || this.o.isDestroyed()) return;
      this.reloadNow();
    }, this.o.reloadDelayMs);
  }

  private reloadNow(): void {
    try {
      this.o.logger.info('Reloading the window');
      this.o.reload();
    } catch (e) {
      this.o.logger.error('Could not reload the window', e);
    }
  }
}
