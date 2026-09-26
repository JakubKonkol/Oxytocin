import { fromUtilityProcess } from '@shared/rpc/adapters';
import type { HostBaseEvents, HostBaseMethods } from '@shared/rpc/contracts/host-base';
import { type CallOptions, createPortRpc, type PortRpc, type RpcEvents, type RpcMethods } from '@shared/rpc/port-rpc';
import type { HostState, HostStatus } from '@shared/domain/app-info';
import { OxyError } from '@shared/errors';
import type { Logger, LogRecord } from '@shared/logging/logger';
import { type Disposable, toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';

/** Structural subset of Electron's UtilityProcess used by the supervisor (fakeable in tests). */
export interface HostProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown, transfer?: never[]): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  kill(): boolean;
}

export interface UtilityHostOptions {
  name: string;
  spawn: () => HostProcess;
  logger: Logger;
  onLog?: (record: LogRecord) => void;
  restartDelaysMs?: readonly number[];
  maxRestarts?: number;
  restartWindowMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  maxMissedPings?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
}

type Params<F> = F extends (params: infer P) => unknown ? P : never;
type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/**
 * Supervises a utility process: RPC, restart with backoff (0.5 s → 2 s → 5 s, max 3 restarts / 5 min,
 * then `failed`) and health checks (ping every 10 s, 3 missed → kill + restart).
 */
export class UtilityHost<
  Methods extends RpcMethods & HostBaseMethods,
  Events extends RpcEvents & HostBaseEvents,
> implements Disposable {
  private child: HostProcess | undefined;
  private rpc: PortRpc<Methods, RpcEvents, Events> | undefined;
  private rpcSubscriptions: Disposable[] = [];
  private _state: HostState = 'stopped';
  private _pid: number | null = null;
  private restartTimes: number[] = [];
  private totalRestarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private missedPings = 0;
  private stopping = false;
  private readyWaiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private readonly eventListeners = new Map<string, Set<(payload: unknown, ports: readonly unknown[]) => void>>();
  /** Methods the host may call on main (mutable: services register them after construction). */
  private readonly served: Record<string, (params: never) => unknown> = {};

  private readonly stateEmitter = new Emitter<HostStatus>();
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly readyEmitter = new Emitter<{ pid: number; restarted: boolean }>();
  /** Fires every time the host (re)starts and reports ready — re-send subscriptions here. */
  readonly onDidBecomeReady = this.readyEmitter.event;

  private readonly o: Required<Omit<UtilityHostOptions, 'onLog'>> & Pick<UtilityHostOptions, 'onLog'>;

  constructor(options: UtilityHostOptions) {
    this.o = {
      restartDelaysMs: [500, 2000, 5000],
      maxRestarts: 3,
      restartWindowMs: 5 * 60_000,
      pingIntervalMs: 10_000,
      pingTimeoutMs: 3_000,
      maxMissedPings: 3,
      shutdownTimeoutMs: 3_000,
      now: () => Date.now(),
      ...options,
    };
  }

  get name(): string {
    return this.o.name;
  }

  get state(): HostState {
    return this._state;
  }

  get status(): HostStatus {
    return { name: this.o.name, state: this._state, pid: this._pid, restarts: this.totalRestarts };
  }

  /** Serves methods the host calls on main (`rpc.call` from the host side). */
  serve(methods: Record<string, (params: never) => unknown>): Disposable {
    Object.assign(this.served, methods);
    return toDisposable(() => {
      for (const name of Object.keys(methods)) if (this.served[name] === methods[name]) delete this.served[name];
    });
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.launch(false);
  }

  private setState(state: HostState): void {
    if (this._state === state) return;
    this._state = state;
    this.stateEmitter.fire(this.status);
  }

  private launch(restarted: boolean): void {
    this.setState(restarted ? 'restarting' : 'starting');
    let child: HostProcess;
    try {
      child = this.o.spawn();
    } catch (e) {
      this.o.logger.error(`Failed to start ${this.o.name}`, e);
      this.handleExit(-1);
      return;
    }
    this.child = child;
    this._pid = child.pid ?? null;
    const rpc = createPortRpc<Methods, RpcEvents, Events>(fromUtilityProcess(child), this.served);
    this.rpc = rpc;
    this.rpcSubscriptions = [
      rpc.onEvent('log', (record) => this.forwardLog(record)),
      rpc.onEvent('ready', (payload) => this.handleReady(payload.pid, restarted)),
    ];
    for (const [name, listeners] of this.eventListeners) {
      this.rpcSubscriptions.push(this.attachListenerSet(rpc, name, listeners));
    }
    child.on('exit', (code: number) => {
      if (this.child !== child) return;
      this.handleExit(code);
    });
  }

  private attachListenerSet(
    rpc: PortRpc<Methods, RpcEvents, Events>,
    name: string,
    listeners: Set<(payload: unknown, ports: readonly unknown[]) => void>,
  ): Disposable {
    return rpc.onEvent(name, (payload, ports) => {
      for (const l of [...listeners]) l(payload, ports);
    });
  }

  private forwardLog(record: LogRecord): void {
    if (this.o.onLog) this.o.onLog(record);
    else this.o.logger[record.level](`[${record.scope}] ${record.message}`);
  }

  private handleReady(pid: number, restarted: boolean): void {
    this._pid = pid;
    this.missedPings = 0;
    this.setState('running');
    this.o.logger.info(`${this.o.name} ${restarted ? 'restarted' : 'started'} (pid ${pid})`);
    for (const w of this.readyWaiters.splice(0)) w.resolve();
    this.startPing();
    this.readyEmitter.fire({ pid, restarted });
  }

  private handleExit(code: number): void {
    this.stopPing();
    this.child = undefined;
    this._pid = null;
    for (const d of this.rpcSubscriptions.splice(0)) d.dispose();
    this.rpc?.rejectPending(new OxyError('UNAVAILABLE', `${this.o.name} exited with code ${code}`));
    this.rpc?.dispose();
    this.rpc = undefined;
    if (this.stopping) {
      this.setState('stopped');
      this.rejectWaiters(new OxyError('UNAVAILABLE', `${this.o.name} stopped`));
      return;
    }
    const now = this.o.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.o.restartWindowMs);
    if (this.restartTimes.length >= this.o.maxRestarts) {
      this.o.logger.error(`${this.o.name} exited with code ${code}; restart limit reached — giving up`);
      this.setState('failed');
      this.rejectWaiters(new OxyError('UNAVAILABLE', `${this.o.name} failed`));
      return;
    }
    const delays = this.o.restartDelaysMs;
    const delay = delays[Math.min(this.restartTimes.length, delays.length - 1)] ?? 1000;
    this.restartTimes.push(now);
    this.totalRestarts++;
    this.o.logger.warn(`${this.o.name} exited unexpectedly with code ${code}; restarting in ${delay} ms`);
    this.setState('restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.stopping) this.launch(true);
    }, delay);
  }

  private rejectWaiters(error: OxyError): void {
    for (const w of this.readyWaiters.splice(0)) w.reject(error);
  }

  private startPing(): void {
    this.stopPing();
    if (this.o.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      const rpc = this.rpc;
      if (!rpc || this._state !== 'running') return;
      rpc.call('ping', null as never, { timeoutMs: this.o.pingTimeoutMs }).then(
        () => {
          this.missedPings = 0;
        },
        () => {
          this.missedPings++;
          this.o.logger.warn(`${this.o.name} did not answer ping (${this.missedPings}/${this.o.maxMissedPings})`);
          if (this.missedPings >= this.o.maxMissedPings) {
            this.o.logger.error(`${this.o.name} is unresponsive; killing it`);
            this.child?.kill();
          }
        },
      );
    }, this.o.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  /** Resolves once the host is running (rejects if it fails or is stopped). */
  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this._state === 'running') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(new OxyError('UNAVAILABLE', `${this.o.name} failed`));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new OxyError('TIMEOUT', `${this.o.name} did not become ready`));
      }, timeoutMs);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      };
      this.readyWaiters.push(waiter);
    });
  }

  async call<M extends keyof Methods & string>(
    method: M,
    params: Params<Methods[M]>,
    opts?: CallOptions,
  ): Promise<Result<Methods[M]>> {
    await this.whenReady(opts?.timeoutMs);
    const rpc = this.rpc;
    if (!rpc) throw new OxyError('UNAVAILABLE', `${this.o.name} is not running`);
    return rpc.call(method, params, opts);
  }

  /** Sends an event to the host (dropped when the host is not running). */
  emit(name: string, payload: unknown, transfer?: unknown[]): void {
    this.rpc?.emit(name, payload, transfer);
  }

  /** Subscribes to host events; the subscription survives restarts. */
  onEvent<E extends keyof Events & string>(
    name: E,
    listener: (payload: Events[E], ports: readonly unknown[]) => void,
  ): Disposable {
    let set = this.eventListeners.get(name);
    if (!set) {
      set = new Set();
      this.eventListeners.set(name, set);
      if (this.rpc) this.rpcSubscriptions.push(this.attachListenerSet(this.rpc, name, set));
    }
    const wrapped = listener as (payload: unknown, ports: readonly unknown[]) => void;
    set.add(wrapped);
    return toDisposable(() => set.delete(wrapped));
  }

  /** Kills the process as if it crashed (used by tests and "restart host" commands). */
  kill(): void {
    this.child?.kill();
  }

  /** Graceful stop: asks the host to shut down, kills it after the timeout. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.o.shutdownTimeoutMs));
    this.rpc?.call('shutdown', null as never, { timeoutMs: this.o.shutdownTimeoutMs }).catch(() => undefined);
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      this.o.logger.warn(`${this.o.name} did not exit in time; killing it`);
      child.kill();
    }
  }

  dispose(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.stopPing();
    this.child?.kill();
    this.stateEmitter.dispose();
    this.readyEmitter.dispose();
  }
}
