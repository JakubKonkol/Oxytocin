import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileCollector } from './file-collector';
import type { Cursor } from './tail';

it('ingests a continuously written log before filesystem activity stops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oxy-usage-continuous-'));
  const file = join(root, 'session.jsonl');
  await writeFile(file, 'initial\n');
  const cursors = new Map<string, Cursor>();
  const parsed: string[] = [];
  const collector = new FileCollector(
    {
      source: 'codex-rollout',
      roots: () => [root],
      match: (p) => p.endsWith('.jsonl'),
      accept: () => true,
      parse: (line) => {
        parsed.push(line);
        return [];
      },
    },
    {
      getCursor: (p) => cursors.get(p),
      commit: (_items, cursor) => {
        cursors.set(cursor.path, cursor);
      },
      readText: (p) => readFile(p, 'utf8'),
      now: Date.now,
      backfillDays: () => 30,
      warn: () => undefined,
    },
  );
  await collector.start();
  parsed.length = 0;
  let writes = Promise.resolve();
  const timer = setInterval(() => {
    writes = writes.then(() => appendFile(file, 'new event\n'));
  }, 10);
  try {
    await vi.waitFor(() => expect(parsed).toContain('new event'), { interval: 20, timeout: 1500 });
  } finally {
    clearInterval(timer);
    await writes;
    collector.stop();
    await collector.idle();
  }
});
