import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBaseEvents, HostBaseMethods } from '@shared/rpc/contracts/host-base';
import { createEndpointPair } from '@shared/rpc/adapters';
import { createPortRpc } from '@shared/rpc/port-rpc';
import type { Logger } from '@shared/logging/logger';
import { type HostProcess, UtilityHost } from './utility-host';

let nextPid = 100;

class FakeHostProcess extends EventEmitter implements HostProcess {
  readonly pid = nextPid++;
  answerPings = true;
  killed = false;
  private readonly mainSide;

  constructor(opts: { ready?: boolean } = {}) {
    super();
    const [mainSide, hostSide] = createEndpointPair();
    this.mainSide = mainSide;
    mainSide.onMessage((m) => this.emit('message', m));
    const hostRpc = createPortRpc(hostSide, {
      ping: () => (this.answerPings ? 'pong' : new Promise(() => undefined)),
      shutdown: () => {
        setTimeout(() => this.exit(0), 1);
      },
      echo: (p: string) => p,
    });
    if (opts.ready !== false) {
      queueMicrotask(() => {
        hostRpc.emit('log', { level: 'info', scope: 'fake', message: 'hello' });
        hostRpc.emit('ready', { pid: this.pid });
      });
    }
  }

  postMessage(message: unknown): void {
    this.mainSide.postMessage(message);
  }

  kill(): boolean {
    this.killed = true;
    this.exit(1);
    return true;
  }

  exit(code: number): void {
    queueMicrotask(() => this.emit('exit', code));
  }
}

type Methods = HostBaseMethods & { echo: (p: string) => string };

const logger = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  const push = (m: string) => lines.push(m);
  return { lines, error: push, warn: push, info: push, debug: push };
};

describe('UtilityHost', () => {
  let processes: FakeHostProcess[];
  beforeEach(() => {
    processes = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (opts: Partial<ConstructorParameters<typeof UtilityHost>[0]> = {}) => {
    const log = logger();
    const host = new UtilityHost<Methods, HostBaseEvents>({
      name: 'Test Host',
      logger: log,
      spawn: () => {
        const p = new FakeHostProcess();
        processes.push(p);
        return p;
      },
      now: () => Date.now(),
      ...opts,
    });
    return { host, log };
  };

  it('starts, becomes ready and serves calls', async () => {
    const { host, log } = make();
    host.start();
    await host.whenReady();
    expect(host.state).toBe('running');
    await expect(host.call('echo', 'hi')).resolves.toBe('hi');
    expect(log.lines.some((l) => l.includes('[fake] hello'))).toBe(true);
    host.dispose();
  });

  it('restarts after an unexpected exit with backoff and rejects pending calls', async () => {
    const { host, log } = make();
    const ready = vi.fn();
    host.onDidBecomeReady(ready);
    host.start();
    await host.whenReady();
    processes[0]!.answerPings = false;
    const pending = host.call('ping', null, { timeoutMs: 0 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    processes[0]!.exit(3);
    await assertion;
    expect(host.state).toBe('restarting');
    await vi.advanceTimersByTimeAsync(499);
    expect(processes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processes).toHaveLength(2);
    await host.whenReady();
    expect(host.status.restarts).toBe(1);
    expect(ready).toHaveBeenLastCalledWith({ pid: processes[1]!.pid, restarted: true });
    expect(log.lines.some((l) => l.includes('restarting in 500 ms'))).toBe(true);
    host.dispose();
  });

  it('gives up after 3 restarts within 5 minutes', async () => {
    const { host } = make();
    host.start();
    await host.whenReady();
    for (const delay of [500, 2000, 5000]) {
      processes.at(-1)!.exit(1);
      await vi.advanceTimersByTimeAsync(delay);
      await host.whenReady();
    }
    processes.at(-1)!.exit(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(host.state).toBe('failed');
    await expect(host.call('echo', 'x')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    host.dispose();
  });

  it('kills an unresponsive host after 3 missed pings', async () => {
    const { host } = make({ pingIntervalMs: 1000, pingTimeoutMs: 100 });
    host.start();
    await host.whenReady();
    processes[0]!.answerPings = false;
    await vi.advanceTimersByTimeAsync(3 * 1000 + 200);
    expect(processes[0]!.killed).toBe(true);
    host.dispose();
  });

  it('keeps event subscriptions across restarts', async () => {
    const { host } = make();
    const logs: string[] = [];
    host.onEvent('log', (r) => logs.push(r.message));
    host.start();
    await host.whenReady();
    processes[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(500);
    await host.whenReady();
    expect(logs).toEqual(['hello', 'hello']);
    host.dispose();
  });

  it('stops gracefully without restarting', async () => {
    const { host } = make();
    host.start();
    await host.whenReady();
    const stopped = host.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    expect(host.state).toBe('stopped');
    expect(processes).toHaveLength(1);
    expect(processes[0]!.killed).toBe(false);
  });
});
