import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxyError } from '../errors';
import { createEndpointPair } from './adapters';
import { createPortRpc } from './port-rpc';

type ServerMethods = {
  add: (p: { a: number; b: number }) => number;
  fail: (p: { code: 'NOT_FOUND' | 'INTERNAL' }) => never;
  slow: (p: { ms: number }) => Promise<string>;
};

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const [left, right] = createEndpointPair();
  const server = createPortRpc(right, {
    add: (p: { a: number; b: number }) => p.a + p.b,
    fail: (p: { code: 'NOT_FOUND' | 'INTERNAL' }) => {
      if (p.code === 'NOT_FOUND') throw new OxyError('NOT_FOUND', 'missing thing');
      throw new Error('kaboom');
    },
    slow: (p: { ms: number }) => new Promise<string>((r) => setTimeout(() => r('done'), p.ms)),
  });
  const client = createPortRpc<ServerMethods, { ping: { n: number } }, { hello: string }>(left);
  return { client, server };
}

describe('createPortRpc', () => {
  it.each(['success', 'failure', 'unknown'] as const)('handles a disconnected peer after %s', async (outcome) => {
    let deliver!: (message: unknown, ports: readonly unknown[]) => void;
    const postMessage = vi.fn(() => {
      throw new Error('port closed');
    });
    const rpc = createPortRpc(
      {
        postMessage,
        onMessage: (listener) => {
          deliver = listener;
          return { dispose() {} };
        },
      },
      {
        success: () => 'done',
        failure: () => {
          throw new Error('failed');
        },
      },
    );
    deliver({ k: 'req', id: 1, m: outcome, p: null }, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postMessage).toHaveBeenCalled();
    rpc.dispose();
  });

  it('does not send a reply when a request finishes after disposal', async () => {
    const [left, right] = createEndpointPair();
    const pending = Promise.withResolvers<string>();
    const send = vi.spyOn(right, 'postMessage');
    const server = createPortRpc(right, { slow: () => pending.promise });
    left.postMessage({ k: 'req', id: 1, m: 'slow', p: null });
    await Promise.resolve();
    server.dispose();
    pending.resolve('done');
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('serves only its own methods, never Object.prototype ones', async () => {
    const { client } = setup();
    await expect(
      (client as unknown as { call: (m: string, p: unknown) => Promise<unknown> }).call('toString', null),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('delivers an event to every listener when one throws', () => {
    let deliver: (message: unknown) => void = () => undefined;
    const receiver = createPortRpc<never, never, { hello: string }>({
      postMessage: () => undefined,
      onMessage: (listener) => {
        deliver = (message) => listener(message, []);
        return { dispose: () => undefined };
      },
    });
    const second = vi.fn();
    receiver.onEvent('hello', () => {
      throw new Error('broken listener');
    });
    receiver.onEvent('hello', second);
    expect(() => deliver({ k: 'evt', n: 'hello', p: 'world' })).toThrow('broken listener');
    expect(second).toHaveBeenCalledWith('world', []);
  });

  it('performs request/response', async () => {
    const { client } = setup();
    await expect(client.call('add', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('propagates OxyError codes and maps unknown errors to INTERNAL', async () => {
    const { client } = setup();
    await expect(client.call('fail', { code: 'NOT_FOUND' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'missing thing',
    });
    await expect(client.call('fail', { code: 'INTERNAL' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'kaboom',
    });
  });

  it('rejects unknown methods with NOT_FOUND', async () => {
    const { client } = setup();
    await expect((client.call as (m: string, p: unknown) => Promise<unknown>)('nope', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('times out slow calls', async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const promise = client.call('slow', { ms: 10_000 }, { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
  });

  it('delivers events in both directions', async () => {
    const { client, server } = setup();
    const received: unknown[] = [];
    server.onEvent('ping', (p) => received.push(p));
    const hello = new Promise((resolve) => client.onEvent('hello', resolve));
    client.emit('ping', { n: 1 });
    server.emit('hello', 'world');
    await expect(hello).resolves.toBe('world');
    expect(received).toEqual([{ n: 1 }]);
  });

  it('rejects pending calls on rejectPending and after dispose', async () => {
    const { client } = setup();
    const promise = client.call('slow', { ms: 10_000 });
    client.rejectPending(new OxyError('UNAVAILABLE', 'host exited'));
    await expect(promise).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    client.dispose();
    await expect(client.call('add', { a: 1, b: 1 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('ignores foreign messages on the same endpoint', async () => {
    const [left, right] = createEndpointPair();
    const server = createPortRpc(right, { add: (p: { a: number; b: number }) => p.a + p.b });
    const client = createPortRpc<ServerMethods>(left);
    right.postMessage({ unrelated: true });
    left.postMessage('text');
    await expect(client.call('add', { a: 1, b: 2 })).resolves.toBe(3);
    server.dispose();
  });
});
