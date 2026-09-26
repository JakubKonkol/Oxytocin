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
