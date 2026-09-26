import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import type { PtyHostEvents } from '@shared/rpc/contracts/pty-host';
import type { PtyToRenderer } from '@shared/rpc/contracts/pty-channel';
import type { SpawnOptions, TerminalSnapshot } from '@shared/domain/terminal';
import type { Logger } from '@shared/logging/logger';
import { DataBatcher } from './data-batcher';
import { FlowController } from './flow-control';
import { HeadlessMirror } from './headless-mirror';
import { isAlive, killProcessTree } from './process-tree';

export type SpawnPty = (file: string, args: string[], options: IPtyForkOptions | IWindowsPtyForkOptions) => IPty;

export interface Subscriber {
  send(message: PtyToRenderer): void;
}

type EmitFn = <E extends keyof PtyHostEvents>(name: E, payload: PtyHostEvents[E]) => void;

export interface TerminalSessionDeps {
  spawnPty: SpawnPty;
  emit: EmitFn;
  logger: Logger;
  platform?: NodeJS.Platform;
  killTimeoutMs?: number;
}

const INITIAL_COMMAND_FALLBACK_MS = 300;

/** A PTY process + its headless mirror, batching, sequencing and flow control (docs/plan/04 §3). */
export class TerminalSession {
  readonly id: string;
  readonly pty: IPty;
  private readonly mirror: HeadlessMirror;
  private readonly batcher: DataBatcher;
  private readonly flow: FlowController;
  private readonly subscribers = new Set<Subscriber>();
  /** Subscribers waiting for their snapshot; data broadcast meanwhile is queued for them. */
  private readonly pending = new Map<Subscriber, PtyToRenderer[]>();
  private seq = 0;
  private _alive = true;
  private exitInfo: { exitCode: number; signal?: number } | undefined;
  private lastOutputAt = 0;
  private lastActivityEmit = 0;
  private titleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingTitle: string | undefined;
  private lastBellAt = 0;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private initialCommand: string | undefined;
  private initialCommandTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly platform: NodeJS.Platform;

  constructor(
    opts: SpawnOptions,
    private readonly deps: TerminalSessionDeps,
  ) {
    this.id = opts.id;
    this.platform = deps.platform ?? process.platform;
    const emit = deps.emit;
    this.mirror = new HeadlessMirror(opts.cols, opts.rows, opts.scrollback, {
      onTitle: (title) => this.scheduleTitle(title),
      onBell: () => {
        const now = Date.now();
        if (now - this.lastBellAt < 1000) return;
        this.lastBellAt = now;
        emit('terminal:bell', { id: this.id });
      },
      onProgress: (state, value) =>
        emit('terminal:progress', value === undefined ? { id: this.id, state } : { id: this.id, state, value }),
      onNotification: (body, title) =>
        emit('terminal:notification', title === undefined ? { id: this.id, body } : { id: this.id, title, body }),
      onCwd: (cwd) => emit('terminal:cwd', { id: this.id, cwd }),
    });
    if (opts.restoreData) this.mirror.write(opts.restoreData);
    this.batcher = new DataBatcher((data) => this.broadcastData(data));

    const ptyOptions: IPtyForkOptions | IWindowsPtyForkOptions =
      this.platform === 'win32'
        ? {
            name: 'xterm-256color',
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env,
            useConpty: true,
            useConptyDll: opts.useConptyDll ?? true,
            conptyInheritCursor: false,
          }
        : { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env, encoding: 'utf8' };
    this.pty = deps.spawnPty(opts.file, opts.args, ptyOptions);
    this.flow = new FlowController({
      pause: () => this.pty.pause(),
      resume: () => this.pty.resume(),
      onTimeout: () => deps.logger.warn(`Terminal ${this.id}: no ACK for 5 s while paused; resuming`),
    });
    this.initialCommand = opts.initialCommand;
    if (this.initialCommand) {
      this.initialCommandTimer = setTimeout(() => this.sendInitialCommand(), INITIAL_COMMAND_FALLBACK_MS);
    }
    this.pty.onData((data) => this.onPtyData(data));
    this.pty.onExit(({ exitCode, signal }) => this.onPtyExit(exitCode, signal));
  }

  get pid(): number {
    return this.pty.pid;
  }

  get alive(): boolean {
    return this._alive;
  }

  get currentSeq(): number {
    return this.seq;
  }

  private onPtyData(data: string): void {
    const now = Date.now();
    this.lastOutputAt = now;
    if (now - this.lastActivityEmit >= 1000) {
      this.lastActivityEmit = now;
      this.deps.emit('terminal:activity', { id: this.id, lastOutputAt: now });
    }
    this.mirror.write(data);
    this.batcher.push(data);
    if (this.initialCommand) this.sendInitialCommand();
  }

  private sendInitialCommand(): void {
    const cmd = this.initialCommand;
    if (!cmd) return;
    this.initialCommand = undefined;
    if (this.initialCommandTimer) clearTimeout(this.initialCommandTimer);
    if (this._alive) this.pty.write(`${cmd}\r`);
  }

  private scheduleTitle(title: string): void {
    this.pendingTitle = title;
    this.titleTimer ??= setTimeout(() => {
      this.titleTimer = undefined;
      if (this.pendingTitle !== undefined) this.deps.emit('terminal:title', { id: this.id, title: this.pendingTitle });
    }, 250);
  }

  private broadcastData(data: string): void {
    const message: PtyToRenderer = { t: 'data', id: this.id, seq: ++this.seq, data };
    for (const queue of this.pending.values()) queue.push(message);
    if (this.subscribers.size === 0) return;
    for (const sub of this.subscribers) sub.send(message);
    this.flow.onSent(data.length);
  }

  private onPtyExit(exitCode: number, signal?: number): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.initialCommandTimer) clearTimeout(this.initialCommandTimer);
    this.batcher.flush();
    this.exitInfo = signal ? { exitCode, signal } : { exitCode };
    this.flow.setAttached(false);
    const message: PtyToRenderer = { t: 'exit', id: this.id, ...this.exitInfo };
    for (const queue of this.pending.values()) queue.push(message);
    for (const sub of this.subscribers) sub.send(message);
    this.deps.emit('terminal:exit', { id: this.id, ...this.exitInfo });
  }

  /**
   * Adds a renderer view: flushes pending output, snapshots the mirror once everything written so far is
   * parsed, then streams further data (seq > snapshot.seq). No gaps, no duplicates.
   */
  attach(sub: Subscriber, cols?: number, rows?: number): void {
    if (this.subscribers.has(sub) || this.pending.has(sub)) this.detach(sub);
    if (cols && rows && this._alive && (cols !== this.mirror.cols || rows !== this.mirror.rows))
      this.resize(cols, rows);
    this.batcher.flush();
    const seq = this.seq;
    this.pending.set(sub, []);
    this.mirror.whenParsed(() => {
      const queued = this.pending.get(sub);
      if (!queued) return; // detached meanwhile
      this.pending.delete(sub);
      sub.send({
        t: 'snapshot',
        id: this.id,
        seq,
        data: this.mirror.serialize(),
        cols: this.mirror.cols,
        rows: this.mirror.rows,
      });
      for (const message of queued) sub.send(message);
      if (!this._alive && this.exitInfo && !queued.some((m) => m.t === 'exit')) {
        sub.send({ t: 'exit', id: this.id, ...this.exitInfo });
      }
      this.subscribers.add(sub);
      this.flow.setAttached(this._alive);
    });
  }

  detach(sub: Subscriber): void {
    this.pending.delete(sub);
    this.subscribers.delete(sub);
    if (this.subscribers.size === 0) this.flow.setAttached(false);
  }

  hasSubscriber(sub: Subscriber): boolean {
    return this.subscribers.has(sub) || this.pending.has(sub);
  }

  ack(chars: number): void {
    this.flow.onAck(chars);
  }

  write(data: string): void {
    if (this._alive) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this._alive || cols < 2 || rows < 1) return;
    if (cols === this.mirror.cols && rows === this.mirror.rows) return;
    try {
      this.pty.resize(cols, rows);
    } catch (e) {
      this.deps.logger.debug(`Terminal ${this.id}: resize failed`, e);
    }
    this.mirror.resize(cols, rows);
  }

  /** Serialized buffer + the seq it corresponds to. */
  snapshot(scrollback?: number): Promise<TerminalSnapshot> {
    this.batcher.flush();
    const seq = this.seq;
    return new Promise((resolve) => {
      this.mirror.whenParsed(() =>
        resolve({ seq, data: this.mirror.serialize(scrollback), cols: this.mirror.cols, rows: this.mirror.rows }),
      );
    });
  }

  setScrollback(scrollback: number): void {
    this.mirror.setScrollback(scrollback);
  }

  /** Graceful kill with a tree-kill fallback after `killTimeoutMs` (3 s); `force` kills the tree at once. */
  kill(force = false): void {
    if (!this._alive) return;
    const pid = this.pty.pid;
    if (force) {
      void killProcessTree(pid, this.platform);
      return;
    }
    try {
      this.pty.kill();
    } catch (e) {
      this.deps.logger.debug(`Terminal ${this.id}: kill failed`, e);
    }
    this.killTimer ??= setTimeout(() => {
      this.killTimer = undefined;
      if (this._alive || isAlive(pid)) void killProcessTree(pid, this.platform);
    }, this.deps.killTimeoutMs ?? 3000);
  }

  /** Plain text of the mirror (tests/diagnostics). */
  getText(): Promise<string> {
    this.batcher.flush();
    return new Promise((resolve) => this.mirror.whenParsed(() => resolve(this.mirror.getText())));
  }

  dispose(): void {
    if (this._alive) this.kill(true);
    if (this.titleTimer) clearTimeout(this.titleTimer);
    if (this.initialCommandTimer) clearTimeout(this.initialCommandTimer);
    this.batcher.dispose();
    this.flow.dispose();
    this.subscribers.clear();
    this.pending.clear();
    this.mirror.dispose();
  }
}
