import { describe, expect, it } from 'vitest';
import { collectDescendants, parsePsPidRows } from './process-tree';

describe('process tree', () => {
  it('parses ps output', () => {
    expect(parsePsPidRows('  1     0\n 20  1\nbad\n 30 20\n')).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 20, ppid: 1 },
      { pid: 30, ppid: 20 },
    ]);
  });

  it('collects descendants breadth-first and tolerates cycles', () => {
    const rows = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 10 },
      { pid: 13, ppid: 11 },
      { pid: 99, ppid: 2 },
      { pid: 1, ppid: 13 },
    ];
    expect(collectDescendants(10, rows)).toEqual([11, 12, 13, 1]);
    expect(collectDescendants(99, rows)).toEqual([]);
  });
});
