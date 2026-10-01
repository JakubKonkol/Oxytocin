import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import type { ProgressState } from '@shared/domain/terminal';
import { type Disposable, DisposableStore, toDisposable } from '@shared/utils/disposable';
import { type Osc633, parseOsc633, parseOsc7, parseOsc777, parseOsc9 } from './osc-parsers';

export interface MirrorSignals {
  onTitle(title: string): void;
  onBell(): void;
  onProgress(state: ProgressState, value?: number): void;
  onNotification(body: string, title?: string): void;
  onCwd(cwd: string): void;
  /** OSC 633 shell integration marks (cwd marks also go to `onCwd`). */
  onShellMark(mark: Exclude<Osc633, { kind: 'cwd' }>): void;
}

const MOUSE_ENCODINGS = [1005, 1006, 1015] as const;

export interface MirrorOptions {
  /**
   * Windows: the ConPTY build. The renderer's xterm gets the same `windowsPty` option, so both handle resizes
   * alike (xterm.js pulls scrollback into a growing viewport only without it). A mirror that resizes differently
   * than the view keeps stale lines that ConPTY's repaints never overwrite, and snapshots show them again.
   */
  windowsBuild?: number;
}

/**
 * Resets modes a restored buffer may have left on (a full-screen app, mouse reporting, focus events, bracketed
 * paste, application cursor keys) so the new shell starts clean. `CSI ?1049l` also restores the saved cursor, so it
 * is only emitted when the snapshot entered the alternate screen.
 */
export function restoreModesReset(snapshot: string): string {
  const leaveAlt = snapshot.includes('\x1b[?1049h') ? '\x1b[?1049l' : '';
  return `\x1b[0m${leaveAlt}\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>`;
}

/**
 * The PTY Host's copy of a terminal buffer (@xterm/headless). It is the source of truth used to
 * rebuild renderer views (snapshot) and to persist scrollback. OSC handlers never consume sequences.
 */
export class HeadlessMirror implements Disposable {
  private readonly term: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly store = new DisposableStore();
  /** Modes the SerializeAddon does not restore (spike S3). */
  private cursorHidden = false;
  private mouseEncoding: number | null = null;

  /** Resolves when a restored buffer has been written completely (see `restore`). */
  private restored: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number, scrollback: number, signals: MirrorSignals, options: MirrorOptions = {}) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      ...(options.windowsBuild !== undefined
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: options.windowsBuild } }
        : {}),
    });
    this.term.loadAddon(this.serializer);
    const parser = this.term.parser;
    const trackModes = (enable: boolean) => (params: (number | number[])[]) => {
      for (const p of params) {
        const mode = Array.isArray(p) ? p[0] : p;
        if (mode === 25) this.cursorHidden = !enable;
        if ((MOUSE_ENCODINGS as readonly (number | undefined)[]).includes(mode)) {
          this.mouseEncoding = enable ? (mode ?? null) : this.mouseEncoding === mode ? null : this.mouseEncoding;
        }
      }
      return false;
    };
    this.store.add(parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackModes(true)));
    this.store.add(parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackModes(false)));
    const resetModes = () => {
      this.cursorHidden = false;
      this.mouseEncoding = null;
      return false;
    };
    // RIS (ESC c) and DECSTR (CSI ! p) show the cursor and turn mouse reporting off.
    this.store.add(parser.registerEscHandler({ final: 'c' }, resetModes));
    this.store.add(parser.registerCsiHandler({ intermediates: '!', final: 'p' }, resetModes));
    this.store.add(this.term.onTitleChange((title) => signals.onTitle(title)));
    this.store.add(this.term.onBell(() => signals.onBell()));
    this.store.add(
      parser.registerOscHandler(9, (data) => {
        const r = parseOsc9(data);
        if (r?.kind === 'progress') signals.onProgress(r.state, r.value);
        else if (r?.kind === 'notification') signals.onNotification(r.body);
        return false;
      }),
    );
    this.store.add(
      parser.registerOscHandler(777, (data) => {
        const r = parseOsc777(data);
        if (r) signals.onNotification(r.body, r.title);
        return false;
      }),
    );
    this.store.add(
      parser.registerOscHandler(7, (data) => {
        const cwd = parseOsc7(data);
        if (cwd) signals.onCwd(cwd);
        return false;
      }),
    );
    this.store.add(
      parser.registerOscHandler(633, (data) => {
        const mark = parseOsc633(data);
        if (mark?.kind === 'cwd') signals.onCwd(mark.cwd);
        else if (mark) signals.onShellMark(mark);
        return false;
      }),
    );
    this.store.add(toDisposable(() => this.term.dispose()));
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** The application turned bracketed paste on (`CSI ?2004h`). */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  write(data: string, callback?: () => void): void {
    this.term.write(data, callback);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  setScrollback(scrollback: number): void {
    this.term.options.scrollback = scrollback;
  }

  /**
   * Serializes the buffer synchronously. Call it from a `write` callback (see `whenParsed`) so the result
   * reflects exactly the data written so far.
   */
  serialize(scrollback?: number): string {
    let data = this.serializer.serialize(scrollback === undefined ? {} : { scrollback });
    if (this.mouseEncoding !== null) data += `\x1b[?${this.mouseEncoding}h`;
    if (this.cursorHidden) data += '\x1b[?25l';
    return data;
  }

  /**
   * Writes a buffer saved earlier (at the last quit, or before a restart) and a dimmed separator line below it
   * (e.g. "── Session restored · … ──"), before the new process writes anything. The separator goes below the last
   * line with content, also when the saved cursor was higher up (an agent's input box has lines below the cursor).
   *
   * With ConPTY (`moveToScrollback`) the restored lines are then scrolled into the scrollback and the cursor goes
   * home: ConPTY starts with an empty screen and the cursor at the top-left, clears the screen and positions its
   * output absolutely. Restored lines left in the viewport would be erased or overwritten and show up again as
   * duplicated prompts with the cursor somewhere else.
   *
   * `write` calls made meanwhile must wait for the returned promise (the caller holds the process output back);
   * `whenParsed` waits for it by itself.
   */
  restore(snapshot: string, label: string, moveToScrollback: boolean): Promise<void> {
    this.restored = new Promise<void>((resolve) => {
      this.term.write(snapshot + restoreModesReset(snapshot), () => {
        const buffer = this.term.buffer.active;
        const cursor = buffer.baseY + buffer.cursorY;
        let last = -1;
        for (let i = buffer.length - 1; i > cursor; i--) {
          if (buffer.getLine(i)?.translateToString(true).trim()) {
            last = i;
            break;
          }
        }
        let tail = `${'\r\n'.repeat(Math.max(0, last - cursor))}\r\n\x1b[2m── ${label} ──\x1b[0m\r\n`;
        if (moveToScrollback) tail += `${'\n'.repeat(Math.max(0, this.term.rows - 1))}\x1b[H`;
        this.term.write(tail, resolve);
      });
    });
    return this.restored;
  }

  /** Runs `fn` once everything written so far has been parsed (and a restored buffer is complete). */
  whenParsed(fn: () => void): void {
    void this.restored.then(() => this.term.write('', fn));
  }

  /** Plain text of the active buffer (tests and diagnostics). */
  getText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\s+$/, '');
  }

  dispose(): void {
    this.store.dispose();
  }
}
