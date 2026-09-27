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

  constructor(cols: number, rows: number, scrollback: number, signals: MirrorSignals) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
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
    this.store.add(
      parser.registerEscHandler({ final: 'c' }, () => {
        this.cursorHidden = false;
        this.mouseEncoding = null;
        return false;
      }),
    );
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

  /** Runs `fn` once everything written so far has been parsed. */
  whenParsed(fn: () => void): void {
    this.term.write('', fn);
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
