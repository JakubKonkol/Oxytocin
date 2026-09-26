import type { EventChannel, InvokeChannel } from '@shared/ipc/channels';
import type { InvokeReq, InvokeRes } from '@shared/ipc/contract';
import type { EventPayload } from '@shared/ipc/events';
import type { OxyPreloadApi } from '@shared/ipc/preload-api';
import { decodeIpcError, fromSerializedError } from '@shared/errors';

declare global {
  interface Window {
    oxy: OxyPreloadApi;
  }
}

/** Typed IPC client generated from the shared contract. Responses from main are trusted (not re-validated). */
export const ipc = {
  async invoke<C extends InvokeChannel>(
    channel: C,
    ...args: undefined extends InvokeReq<C> ? [req?: InvokeReq<C>] : [req: InvokeReq<C>]
  ): Promise<InvokeRes<C>> {
    try {
      return (await window.oxy.invoke(channel, args[0])) as InvokeRes<C>;
    } catch (e) {
      const decoded = e instanceof Error ? decodeIpcError(e.message) : null;
      throw decoded ? fromSerializedError(decoded) : e;
    }
  },
  on<E extends EventChannel>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
    return window.oxy.on(event, (payload) => listener(payload as EventPayload<E>));
  },
};
