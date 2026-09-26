import type { WebContents } from 'electron';
import { INVOKE_CHANNELS, type EventChannel, type InvokeChannel } from '@shared/ipc/channels';
import { invokeContract, type InvokeReqParsed, type InvokeRes } from '@shared/ipc/contract';
import type { EventPayload } from '@shared/ipc/events';
import { encodeIpcError, OxyError, toSerializedError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';

export interface IpcContext {
  sender: WebContents;
}

export type InvokeHandler<C extends InvokeChannel> = (
  req: InvokeReqParsed<C>,
  ctx: IpcContext,
) => Promise<InvokeRes<C>> | InvokeRes<C>;

export type InvokeHandlers = { [C in InvokeChannel]?: InvokeHandler<C> };

/** The part of an ipcMain.handle event we rely on. */
export interface InvokeEventLike {
  sender: WebContents;
  senderFrame: { url: string; parent: unknown } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/** Only the shell's top-level frame may call main — never plugin iframes or foreign origins. */
export function assertTrustedSender(event: InvokeEventLike, isTrustedUrl: (url: string) => boolean): void {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null || !isTrustedUrl(frame.url)) {
    throw new OxyError('PERMISSION', 'IPC from an untrusted frame');
  }
}

/**
 * Registers invoke handlers: sender check → zod validation of the request (ZodError → INVALID) →
 * handler → errors serialized as OxyError (no stack traces to the renderer).
 */
export function registerInvokeHandlers(
  ipc: IpcMainLike,
  handlers: InvokeHandlers,
  opts: { isTrustedUrl: (url: string) => boolean; logger: Logger },
): () => void {
  const registered: string[] = [];
  for (const channel of INVOKE_CHANNELS) {
    // The mapped type guarantees per-channel correctness; erase it for the generic dispatch below.
    const handler = handlers[channel] as ((req: unknown, ctx: IpcContext) => unknown) | undefined;
    if (!handler) continue;
    registered.push(channel);
    ipc.handle(channel, async (event, raw) => {
      try {
        assertTrustedSender(event, opts.isTrustedUrl);
        const spec = invokeContract[channel];
        const parsed = spec.req.safeParse(raw);
        if (!parsed.success) {
          throw new OxyError('INVALID', `Invalid request for ${channel}`, parsed.error.issues);
        }
        return await handler(parsed.data, { sender: event.sender });
      } catch (e) {
        const serialized = toSerializedError(e);
        if (serialized.code === 'INTERNAL') opts.logger.error(`IPC ${channel} failed`, e);
        else opts.logger.debug(`IPC ${channel} rejected: ${serialized.code} ${serialized.message}`);
        throw new Error(encodeIpcError(serialized), { cause: e });
      }
    });
  }
  return () => {
    for (const channel of registered) ipc.removeHandler(channel);
  };
}

/** Sends a typed push event to a renderer. */
export function sendEvent<E extends EventChannel>(target: WebContents, event: E, payload: EventPayload<E>): void {
  if (!target.isDestroyed()) target.send(event, payload);
}
