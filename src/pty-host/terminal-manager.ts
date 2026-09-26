import type { SpawnOptions } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { PtyHostEvents, PtyTerminalListEntry } from '@shared/rpc/contracts/pty-host';
import { isRendererToPty, type PtyToRenderer } from '@shared/rpc/contracts/pty-channel';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { type SpawnPty, type Subscriber, TerminalSession } from './terminal-session';

type EmitFn = <E extends keyof PtyHostEvents>(name: E, payload: PtyHostEvents[E]) => void;

/** Structural port used for renderer connections (Electron MessagePortMain, Node MessagePort adapter…). */
export interface RendererPort {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): Disposable;
  onClose(listener: () => void): Disposable;
  close(): void;
}

/** One renderer window's port; it can subscribe to any number of terminals. */
class RendererConnection implements Subscriber {
  private readonly subscriptions = new Map<string, TerminalSession>();
  private readonly disposables: Disposable[] = [];
  private closed = false;

  constructor(
    readonly windowId: number,
    private readonly port: RendererPort,
    private readonly manager: TerminalManager,
    private readonly logger: Logger,
  ) {
    this.disposables.push(port.onMessage((msg) => this.handle(msg)));
    this.disposables.push(port.onClose(() => this.dispose()));
  }

  send(message: PtyToRenderer): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch (e) {
      this.logger.warn(`Renderer port ${this.windowId} failed; dropping it`, e);
      this.dispose();
    }
  }

  private handle(msg: unknown): void {
    if (!isRendererToPty(msg)) return;
    const session = this.manager.get(msg.id);
    if (!session) {
      if (msg.t === 'attach') this.send({ t: 'error', id: msg.id, code: 'NOT_FOUND', message: 'Terminal not found' });
      return;
    }
    switch (msg.t) {
      case 'attach':
        this.subscriptions.set(msg.id, session);
        session.attach(this, msg.cols, msg.rows);
        break;
      case 'detach':
        this.subscriptions.delete(msg.id);
        session.detach(this);
        break;
      case 'input':
      case 'binary':
        session.write(msg.data);
        break;
      case 'resize':
        session.resize(msg.cols, msg.rows);
        break;
      case 'ack':
        session.ack(msg.chars);
        break;
    }
  }

  forget(id: string): void {
    this.subscriptions.delete(id);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.subscriptions.values()) session.detach(this);
    this.subscriptions.clear();
    for (const d of this.disposables) d.dispose();
    try {
      this.port.close();
    } catch {
      // already closed
    }
    this.manager.removeConnection(this);
  }
}

export interface TerminalManagerDeps {
  spawnPty: SpawnPty;
  emit: EmitFn;
  logger: Logger;
  platform?: NodeJS.Platform;
  killTimeoutMs?: number;
  onSpawned?: () => void;
}

/** Registry of terminal sessions and renderer connections inside the PTY Host. */
export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly connections = new Map<number, RendererConnection>();

  constructor(private readonly deps: TerminalManagerDeps) {}

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  private require(id: string): TerminalSession {
    const s = this.sessions.get(id);
    if (!s) throw new OxyError('NOT_FOUND', `Terminal ${id} not found`);
    return s;
  }

  spawn(opts: SpawnOptions): { pid: number } {
    if (this.sessions.has(opts.id)) throw new OxyError('INVALID', `Terminal ${opts.id} already exists`);
    let session: TerminalSession;
    try {
      session = new TerminalSession(opts, this.deps);
    } catch (e) {
      throw new OxyError(
        'SPAWN_FAILED',
        `Failed to start ${opts.file}: ${e instanceof Error ? e.message : String(e)}`,
        {
          file: opts.file,
          args: opts.args,
          cwd: opts.cwd,
        },
      );
    }
    this.sessions.set(opts.id, session);
    this.deps.logger.info(`Spawned terminal ${opts.id} (pid ${session.pid}): ${opts.file} ${opts.args.join(' ')}`);
    this.deps.onSpawned?.();
    return { pid: session.pid };
  }

  write(id: string, data: string): void {
    this.require(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.require(id).resize(cols, rows);
  }

  kill(id: string, force = false): void {
    this.require(id).kill(force);
  }

  dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const c of this.connections.values()) c.forget(id);
    session.dispose();
  }

  /** Alive terminals for the process monitor. */
  monitored(): { id: string; pid: number; lastOutputAt: number }[] {
    return [...this.sessions.values()]
      .filter((s) => s.alive)
      .map((s) => ({ id: s.id, pid: s.pid, lastOutputAt: s.lastOutput }));
  }

  list(): PtyTerminalListEntry[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, pid: s.pid, alive: s.alive }));
  }

  serialize(id: string, scrollback?: number): Promise<{ seq: number; data: string }> {
    return this.require(id)
      .snapshot(scrollback)
      .then(({ seq, data }) => ({ seq, data }));
  }

  setScrollback(scrollback: number): void {
    for (const s of this.sessions.values()) s.setScrollback(scrollback);
  }

  getText(id: string): Promise<string> {
    return this.require(id).getText();
  }

  /** Registers a renderer window port, replacing (and closing) the window's previous port (renderer reload). */
  addConnection(windowId: number, port: RendererPort): void {
    this.connections.get(windowId)?.dispose();
    this.connections.set(windowId, new RendererConnection(windowId, port, this, this.deps.logger));
  }

  removeConnection(connection: RendererConnection): void {
    if (this.connections.get(connection.windowId) === connection) this.connections.delete(connection.windowId);
  }

  /** Kills every terminal: graceful first, then the process trees after `graceMs`. */
  async shutdown(graceMs = 3000): Promise<void> {
    const sessions = [...this.sessions.values()].filter((s) => s.alive);
    for (const s of sessions) s.kill(false);
    const deadline = Date.now() + graceMs;
    while (sessions.some((s) => s.alive) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const s of sessions) if (s.alive) s.kill(true);
    for (const c of [...this.connections.values()]) c.dispose();
  }
}
