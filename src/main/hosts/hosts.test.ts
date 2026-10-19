import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import type * as Os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hosts } from './hosts';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), priority: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  setPriority: mocks.priority,
}));
vi.mock('../app/paths', () => ({ appPaths: { hostEntry: (name: string) => `/out/${name}.js` } }));
vi.mock('../logging/log', () => ({ writeForwardedLog: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Code Map Host supervision', () => {
  it.each([false, true])(
    'starts lazily, lowers process priority and tolerates a priority failure (%s)',
    async (fail) => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        postMessage: vi.fn(),
        kill: vi.fn(() => true),
        stdout: null,
        stderr: null,
      });
      mocks.fork.mockReturnValue(child);
      mocks.priority.mockImplementation(() => {
        if (fail) throw new Error('priority denied');
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const hosts = new Hosts(
        () => logger,
        () => ({}),
      );
      expect(hosts.codeMap.state).toBe('stopped');
      expect(mocks.fork).not.toHaveBeenCalled();
      hosts.ensureCodeMap();
      child.emit('spawn');
      hosts.ensureCodeMap();
      expect(mocks.fork).toHaveBeenCalledTimes(1);
      expect(mocks.fork).toHaveBeenCalledWith(
        '/out/codeMapHost.js',
        [],
        expect.objectContaining({ serviceName: 'Oxytocin Code Map Host' }),
      );
      expect(mocks.priority).toHaveBeenCalledWith(1234, constants.priority.PRIORITY_BELOW_NORMAL);
      expect(hosts.status().find((status) => status.name === 'Oxytocin Code Map Host')).toMatchObject({
        state: 'starting',
      });
      if (fail) expect(logger.warn).toHaveBeenCalledWith('Could not lower Code Map Host priority', expect.any(Error));
      const stop = hosts.stopAll();
      await vi.runAllTimersAsync();
      await stop;
    },
  );
});
