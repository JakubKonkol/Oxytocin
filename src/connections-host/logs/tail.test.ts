import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLogFile, tailLog } from './tail';

describe('log tail', () => {
  it('reads the last lines, filters and picks the newest file of a glob', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-logs-'));
    const lines = Array.from({ length: 50_000 }, (_, i) => `${i % 10 === 0 ? 'ERROR' : 'info'} line ${i}`);
    await writeFile(join(dir, 'api-1.log'), 'old\n');
    await writeFile(join(dir, 'api-2.log'), `${lines.join('\r\n')}\r\n`);
    await utimes(join(dir, 'api-1.log'), new Date(1000), new Date(1000));
    expect(await resolveLogFile(dir, 'api-*.log')).toBe(join(dir, 'api-2.log'));
    const tail = await tailLog({ root: dir, path: 'api-*.log', lines: 3 });
    expect(tail.split('\n').slice(1)).toEqual(['info line 49997', 'info line 49998', 'info line 49999']);
    const errors = await tailLog({ root: dir, path: join(dir, 'api-2.log'), lines: 2, grep: '^error' });
    expect(errors.split('\n').slice(1)).toEqual(['ERROR line 49980', 'ERROR line 49990']);
    await expect(tailLog({ root: dir, path: 'api-2.log', lines: 1, grep: '(' })).rejects.toThrow(/Invalid grep/);
    await expect(resolveLogFile(dir, 'nope-*.log')).rejects.toThrow(/No file matches/);
    expect(await tailLog({ root: dir, path: 'api-1.log', lines: 10 })).toMatch(/1 line:\nold$/);
  });
});
