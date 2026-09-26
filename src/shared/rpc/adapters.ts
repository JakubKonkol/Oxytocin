import { type Disposable, toDisposable } from '../utils/disposable';
import type { RpcEndpoint } from './port-rpc';

/** Minimal structural type of a DOM MessagePort / Electron MessagePortMain. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: never[]): void;
  start?(): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): void;
  on?(type: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown;
  off?(type: 'message', listener: (event: { data: unknown; ports?: readonly unknown[] }) => void): unknown;
}

/** Works for both DOM MessagePort (addEventListener) and Electron MessagePortMain / parentPort (on/off). */
export function fromMessagePort(port: MessagePortLike): RpcEndpoint {
  return {
    postMessage: (message, transfer) => port.postMessage(message, transfer as never[] | undefined),
    onMessage(listener): Disposable {
      const handler = (event: { data: unknown; ports?: readonly unknown[] }) => listener(event.data, event.ports ?? []);
      if (port.on && port.off) {
        port.on('message', handler);
        port.start?.();
        return toDisposable(() => port.off?.('message', handler));
      }
      port.addEventListener?.('message', handler);
      port.start?.();
      return toDisposable(() => port.removeEventListener?.('message', handler));
    },
  };
}

/** Structural type of Electron's UtilityProcess (as seen from main). */
export interface UtilityProcessLike {
  postMessage(message: unknown, transfer?: never[]): void;
  on(type: 'message', listener: (message: unknown) => void): unknown;
  off(type: 'message', listener: (message: unknown) => void): unknown;
}

export function fromUtilityProcess(child: UtilityProcessLike): RpcEndpoint {
  return {
    postMessage: (message, transfer) => child.postMessage(message, transfer as never[] | undefined),
    onMessage(listener) {
      const handler = (message: unknown) => listener(message, []);
      child.on('message', handler);
      return toDisposable(() => child.off('message', handler));
    },
  };
}

/** A pair of in-memory endpoints, handy for tests. */
export function createEndpointPair(): [RpcEndpoint, RpcEndpoint] {
  type L = (message: unknown, ports: readonly unknown[]) => void;
  const a = new Set<L>();
  const b = new Set<L>();
  const make = (inbox: Set<L>, outbox: Set<L>): RpcEndpoint => ({
    postMessage: (message, transfer) => {
      const cloned = structuredClone(message);
      queueMicrotask(() => {
        for (const l of [...outbox]) l(cloned, transfer ?? []);
      });
    },
    onMessage(listener) {
      inbox.add(listener);
      return toDisposable(() => inbox.delete(listener));
    },
  });
  return [make(a, b), make(b, a)];
}
