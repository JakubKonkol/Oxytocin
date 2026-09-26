import { afterEach, describe, expect, it, vi } from 'vitest';
import { descendantsOf, ProcessMonitor } from './index';
import { descendantPids, parseCimCommandLines, parsePsArgs, parsePsComm } from './sources';

const row = (pid: number, ppid: number, name: string, commandLine = name) => ({ pid, ppid, name, commandLine });

describe('process tree parsing', () => {
  it('parses ps output including paths with spaces', () => {
    expect(parsePsComm('  10     1 /bin/bash\n 11 10 /Applications/My App.app/Contents/MacOS/x\n')).toEqual(
      new Map([
        [10, { ppid: 1, comm: '/bin/bash' }],
        [11, { ppid: 10, comm: '/Applications/My App.app/Contents/MacOS/x' }],
      ]),
    );
    expect(parsePsArgs(' 10 bash -l\n 11 node /x/cli.js --flag\n')).toEqual(
      new Map([
        [10, 'bash -l'],
        [11, 'node /x/cli.js --flag'],
      ]),
    );
  });

  it('parses CIM JSON (object or array)', () => {
    expect(parseCimCommandLines('{"ProcessId":5,"CommandLine":"node a.js"}')).toEqual(new Map([[5, 'node a.js']]));
    expect(parseCimCommandLines('[{"ProcessId":5,"CommandLine":null},{"ProcessId":6,"CommandLine":"x"}]')).toEqual(
      new Map([
        [5, ''],
        [6, 'x'],
      ]),
    );
    expect(parseCimCommandLines('')).toEqual(new Map());
  });

  it('lists descendants nearest first and skips helpers', () => {
    const rows = [
      row(100, 1, 'bash'),
      row(101, 100, 'node'),
      row(102, 101, 'esbuild'),
      row(103, 100, 'gitstatusd-linux-x86_64'),
      row(200, 1, 'other'),
    ];
    expect(descendantsOf(100, rows).map((d) => d.pid)).toEqual([101, 102]);
    expect(descendantsOf(999, rows)).toEqual([]);
  });
});

describe('ProcessMonitor', () => {
  afterEach(() => vi.useRealTimers());

  it('reports changes only and adapts its interval', async () => {
    vi.useFakeTimers();
    let rows = [row(10, 1, 'bash')];
    const updates: unknown[] = [];
    const lastOutputAt = { value: 0 };
    const monitor = new ProcessMonitor({
      source: { list: () => Promise.resolve(rows) },
      terminals: () => [{ id: 't1', pid: 10, lastOutputAt: lastOutputAt.value }],
      onChange: (u) => updates.push(u),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(updates).toEqual([{ id: 't1', descendants: [] }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates).toHaveLength(1);
    rows = [row(10, 1, 'bash'), row(11, 10, 'npm')];
    lastOutputAt.value = Date.now();
    await vi.advanceTimersByTimeAsync(5000);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ foreground: { pid: 11, name: 'npm' } });
    monitor.stop();
  });
});

describe('descendantPids', () => {
  it('collects all descendants of the roots only', () => {
    const rows = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 },
    ];
    expect([...descendantPids([10], rows)].sort()).toEqual([11, 12]);
  });
});
