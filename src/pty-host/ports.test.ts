import { describe, expect, it } from 'vitest';
import { parseLsof, parseNetstat, parseSs, portsOfTree } from './ports';

describe('listening ports', () => {
  it('parses Windows netstat output (IPv4 and IPv6, listening only)', () => {
    const out = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4120',
      '  TCP    127.0.0.1:52011        127.0.0.1:5173         ESTABLISHED     900',
      '  TCP    [::1]:7043             [::]:0                 LISTENING       5000',
    ].join('\r\n');
    expect(parseNetstat(out)).toEqual([
      { pid: 4120, port: 5173 },
      { pid: 5000, port: 7043 },
    ]);
  });

  it('parses lsof -F output', () => {
    expect(parseLsof('p10\nf20\nn*:3000\nn[::1]:3001\np11\nf5\nn127.0.0.1:4200\n')).toEqual([
      { pid: 10, port: 3000 },
      { pid: 10, port: 3001 },
      { pid: 11, port: 4200 },
    ]);
  });

  it('parses ss output with several owners', () => {
    const out = [
      'LISTEN 0 511 *:5173 *:* users:(("node",pid=1234,fd=20))',
      'LISTEN 0 128 127.0.0.1%lo:8000 0.0.0.0:* users:(("python",pid=77,fd=3),("python",pid=78,fd=3))',
      'LISTEN 0 128 [::]:22 [::]:*',
    ].join('\n');
    expect(parseSs(out)).toEqual([
      { pid: 1234, port: 5173 },
      { pid: 77, port: 8000 },
      { pid: 78, port: 8000 },
    ]);
  });

  it('keeps the ports of the process tree only', () => {
    const rows = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 1 },
      { pid: 9, ppid: 8 },
    ];
    const sockets = [
      { pid: 3, port: 5173 },
      { pid: 3, port: 24678 },
      { pid: 2, port: 5173 },
      { pid: 9, port: 80 },
    ];
    expect(portsOfTree(2, rows, sockets)).toEqual([5173, 24678]);
    expect(portsOfTree(4, rows, sockets)).toEqual([]);
  });
});
