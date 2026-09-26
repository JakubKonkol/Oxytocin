import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { decodeIpcError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { type IpcMainLike, type InvokeEventLike, registerInvokeHandlers } from './router';

const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

function fakeIpc() {
  const handlers = new Map<string, (event: InvokeEventLike, payload: unknown) => Promise<unknown>>();
  const ipc: IpcMainLike = {
    handle: (c, l) => handlers.set(c, l),
    removeHandler: (c) => handlers.delete(c),
  };
  return { ipc, handlers };
}

const event = (url = 'app://oxytocin/index.html', parent: unknown = null): InvokeEventLike => ({
  sender: {} as WebContents,
  senderFrame: { url, parent },
});

const isTrustedUrl = (url: string) => url.startsWith('app://oxytocin/');

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return decodeIpcError((e as Error).message);
  }
  throw new Error('expected rejection');
}

describe('registerInvokeHandlers', () => {
  it('calls the handler with the validated payload', async () => {
    const { ipc, handlers } = fakeIpc();
    const handler = vi.fn(() => ({ 'terminal.fontSize': 13 }) as never);
    registerInvokeHandlers(ipc, { 'settings:get': handler }, { isTrustedUrl, logger });
    await expect(handlers.get('settings:get')!(event(), undefined)).resolves.toEqual({ 'terminal.fontSize': 13 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects invalid payloads with INVALID', async () => {
    const { ipc, handlers } = fakeIpc();
    registerInvokeHandlers(ipc, { 'settings:get': () => ({}) as never }, { isTrustedUrl, logger });
    expect(await rejection(handlers.get('settings:get')!(event(), { unexpected: true }))).toMatchObject({
      code: 'INVALID',
    });
  });

  it('rejects untrusted senders and subframes with PERMISSION', async () => {
    const { ipc, handlers } = fakeIpc();
    const handler = vi.fn();
    registerInvokeHandlers(ipc, { 'settings:get': handler }, { isTrustedUrl, logger });
    expect(await rejection(handlers.get('settings:get')!(event('https://evil.example/'), undefined))).toMatchObject({
      code: 'PERMISSION',
    });
    expect(await rejection(handlers.get('settings:get')!(event(undefined, {}), undefined))).toMatchObject({
      code: 'PERMISSION',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('serializes handler errors without leaking unknown details', async () => {
    const { ipc, handlers } = fakeIpc();
    registerInvokeHandlers(
      ipc,
      {
        'settings:get': () => {
          throw new Error('disk on fire');
        },
      },
      { isTrustedUrl, logger },
    );
    expect(await rejection(handlers.get('settings:get')!(event(), undefined))).toEqual({
      code: 'INTERNAL',
      message: 'disk on fire',
    });
  });

  it('unregisters its handlers', () => {
    const { ipc, handlers } = fakeIpc();
    const dispose = registerInvokeHandlers(ipc, { 'settings:get': () => ({}) as never }, { isTrustedUrl, logger });
    dispose();
    expect(handlers.size).toBe(0);
  });
});
