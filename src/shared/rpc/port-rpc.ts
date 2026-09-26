import { type Disposable, DisposableStore, toDisposable } from '../utils/disposable';
import { fromSerializedError, OxyError, type SerializedOxyError, toSerializedError } from '../errors';

/** A bidirectional message channel (parentPort, UtilityProcess, MessagePort…). */
export interface RpcEndpoint {
  postMessage(message: unknown, transfer?: unknown[]): void;
  /** Subscribes to incoming messages; `ports` carries transferred MessagePorts, if any. */
  onMessage(listener: (message: unknown, ports: readonly unknown[]) => void): Disposable;
}

export type Wire =
  | { k: 'req'; id: number; m: string; p: unknown }
  | { k: 'res'; id: number; ok: true; r: unknown }
  | { k: 'res'; id: number; ok: false; e: SerializedOxyError }
  | { k: 'evt'; n: string; p: unknown };

/** Methods are single-argument functions; results may be sync or async. */
export type RpcMethods = { [name: string]: (params: never) => unknown };
export type RpcEvents = { [name: string]: unknown };

type Params<F> = F extends (params: infer P) => unknown ? P : never;
type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

export interface CallOptions {
  timeoutMs?: number;
}

export interface PortRpc<
  Remote extends RpcMethods,
  Emits extends RpcEvents,
  Receives extends RpcEvents,
> extends Disposable {
  call<M extends keyof Remote & string>(
    method: M,
    params: Params<Remote[M]>,
    opts?: CallOptions,
  ): Promise<Result<Remote[M]>>;
  emit<E extends keyof Emits & string>(name: E, payload: Emits[E], transfer?: unknown[]): void;
  onEvent<E extends keyof Receives & string>(
    name: E,
    listener: (payload: Receives[E], ports: readonly unknown[]) => void,
  ): Disposable;
  /** Rejects all pending calls (e.g. when the remote process exited). */
  rejectPending(error: OxyError): void;
}

export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

function isWire(msg: unknown): msg is Wire {
  return typeof msg === 'object' && msg !== null && 'k' in msg && typeof msg.k === 'string';
}

/**
 * Request/response + events over a message endpoint. `impl` serves incoming requests; methods may be
 * sync or async and may throw OxyError (serialized to the caller). Messages that are not RPC wire
 * messages are ignored so the same endpoint can carry other traffic.
 */
export function createPortRpc<
  Remote extends RpcMethods = RpcMethods,
  Emits extends RpcEvents = RpcEvents,
  Receives extends RpcEvents = RpcEvents,
>(endpoint: RpcEndpoint, impl?: Partial<Record<string, (params: never) => unknown>>): PortRpc<Remote, Emits, Receives> {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined }
  >();
  const listeners = new Map<string, Set<(payload: unknown, ports: readonly unknown[]) => void>>();
  const store = new DisposableStore();

  const send = (msg: Wire, transfer?: unknown[]) => {
    if (transfer && transfer.length > 0) endpoint.postMessage(msg, transfer);
    else endpoint.postMessage(msg);
  };

  const serve = async (msg: Extract<Wire, { k: 'req' }>) => {
    const fn = impl?.[msg.m];
    if (!fn) {
      send({ k: 'res', id: msg.id, ok: false, e: { code: 'NOT_FOUND', message: `Unknown RPC method: ${msg.m}` } });
      return;
    }
    try {
      const result = await fn(msg.p as never);
      send({ k: 'res', id: msg.id, ok: true, r: result });
    } catch (e) {
      send({ k: 'res', id: msg.id, ok: false, e: toSerializedError(e) });
    }
  };

  store.add(
    endpoint.onMessage((msg, ports) => {
      if (!isWire(msg)) return;
      switch (msg.k) {
        case 'req':
          void serve(msg);
          break;
        case 'res': {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          if (entry.timer) clearTimeout(entry.timer);
          if (msg.ok) entry.resolve(msg.r);
          else entry.reject(fromSerializedError(msg.e));
          break;
        }
        case 'evt': {
          const set = listeners.get(msg.n);
          if (!set) return;
          for (const listener of [...set]) listener(msg.p, ports);
          break;
        }
      }
    }),
  );

  const rejectPending = (error: OxyError) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  };

  store.add(toDisposable(() => rejectPending(new OxyError('CANCELLED', 'RPC channel disposed'))));

  return {
    call(method, params, opts) {
      if (store.isDisposed) return Promise.reject(new OxyError('UNAVAILABLE', 'RPC channel disposed'));
      const id = nextId++;
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new OxyError('TIMEOUT', `RPC ${method} timed out after ${timeoutMs} ms`));
              }, timeoutMs)
            : undefined;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        try {
          send({ k: 'req', id, m: method, p: params });
        } catch (e) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(
            new OxyError('UNAVAILABLE', `Failed to send RPC ${method}: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
      });
    },
    emit(name, payload, transfer) {
      if (store.isDisposed) return;
      send({ k: 'evt', n: name, p: payload }, transfer);
    },
    onEvent(name, listener) {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      const wrapped = listener as (payload: unknown, ports: readonly unknown[]) => void;
      set.add(wrapped);
      return toDisposable(() => set.delete(wrapped));
    },
    rejectPending,
    dispose() {
      store.dispose();
      listeners.clear();
    },
  };
}
