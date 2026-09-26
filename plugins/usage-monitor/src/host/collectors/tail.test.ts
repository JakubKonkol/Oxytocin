import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Cursor, fileInfo, needsRead, tailFile } from './tail';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-tail-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function read(path: string, cursor: Cursor | undefined, chunk?: number) {
  const lines: string[] = [];
  let end = cursor?.offset ?? 0;
  let reset = false;
  let info = await fileInfo(path);
  for await (const b of tailFile(path, cursor, () => true, undefined, chunk)) {
    lines.push(...b.lines.map((l) => l.toString()));
    end = b.endOffset;
    reset ||= b.reset;
    info = b;
  }
  const next: Cursor = {
    path,
    source: 't',
    fileId: info.fileId,
    size: info.size,
    mtimeMs: info.mtimeMs,
    offset: end,
    state: null,
  };
  return { lines, next, reset };
}

describe('tailFile', () => {
  it('reads complete lines only and continues from the cursor', async () => {
    const f = join(dir, 'a.jsonl');
    await writeFile(f, '{"a":1}\n{"b":2}\n{"c":');
    const first = await read(f, undefined);
    expect(first.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(first.next.offset).toBe(16);
    expect(needsRead(await fileInfo(f), first.next)).toBe(true);

    await appendFile(f, '3}\n\n{"d":4}\n');
    const second = await read(f, first.next);
    expect(second.lines).toEqual(['{"c":3}', '{"d":4}']);
    expect(needsRead(await fileInfo(f), second.next)).toBe(false);
  });

  it('starts over when the file was truncated or replaced', async () => {
    const f = join(dir, 'b.jsonl');
    await writeFile(f, 'one\ntwo\nthree\n');
    const first = await read(f, undefined);
    await writeFile(f, 'x\n');
    const truncated = await read(f, first.next);
    expect(truncated).toMatchObject({ lines: ['x'], reset: true });

    await rm(f);
    await writeFile(f, 'x\ny\nz\nlonger line\n');
    const replaced = await read(f, { ...truncated.next, fileId: 'other' });
    expect(replaced.reset).toBe(true);
    expect(replaced.lines).toEqual(['x', 'y', 'z', 'longer line']);
  });

  it('handles lines longer than a chunk and multi-byte characters across chunk borders', async () => {
    const f = join(dir, 'c.jsonl');
    const long = `{"t":"${'ż'.repeat(50)}"}`;
    await writeFile(f, `${long}\nshort\n${long}`);
    const r = await read(f, undefined, 7);
    expect(r.lines).toEqual([long, 'short']);
    expect(r.next.offset).toBe(Buffer.byteLength(`${long}\nshort\n`));
  });
});
