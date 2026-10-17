import { mkdtemp, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentLimitRecord } from '../model';
import {
  ClaudeStatusLineReader,
  parseStatusLineInput,
  STATUSLINE_DATA_FILE,
  STATUSLINE_POLL_MS,
} from './claude-statusline';

const input = (rateLimits: unknown) =>
  JSON.stringify({ session_id: 's1', model: { id: 'claude-opus-5-5' }, rate_limits: rateLimits });

describe('parseStatusLineInput', () => {
  it('reads the 5-hour, weekly and spend windows (resets_at in seconds → ms)', () => {
    const items = parseStatusLineInput(
      input({
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
        spend_limit: { used_percentage: 104, resets_at: 1740787200 },
      }),
      1000,
    );
    expect(items).toEqual([
      {
        kind: 'limit',
        agent: 'claude-code',
        account: 'main',
        window: 'five_hour',
        usedPercent: 23.5,
        windowMinutes: 300,
        resetsAt: 1738425600000,
        observedAt: 1000,
      },
      expect.objectContaining({ window: 'seven_day', usedPercent: 41.2, windowMinutes: 10080 }),
      expect.objectContaining({ window: 'spend_limit', usedPercent: 104, windowMinutes: null }),
    ]);
  });

  it('skips absent or malformed windows and ignores other input', () => {
    expect(
      parseStatusLineInput(input({ five_hour: { used_percentage: 'x' }, seven_day: { used_percentage: 5 } }), 1),
    ).toEqual([expect.objectContaining({ window: 'seven_day', resetsAt: null })]);
    expect(parseStatusLineInput(JSON.stringify({ session_id: 's1' }), 1)).toEqual([]);
    expect(parseStatusLineInput('not json', 1)).toEqual([]);
  });
});

describe('ClaudeStatusLineReader', () => {
  it('polls even without watcher events and stops polling on disposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-statusline-poll-'));
    const reader = new ClaudeStatusLineReader(dir, () => undefined);
    vi.useFakeTimers();
    try {
      await reader.start();
      const read = vi.spyOn(reader, 'read');
      await vi.advanceTimersByTimeAsync(STATUSLINE_POLL_MS);
      expect(read).toHaveBeenCalledTimes(1);
      reader.stop();
      await vi.advanceTimersByTimeAsync(STATUSLINE_POLL_MS);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      reader.stop();
      vi.useRealTimers();
    }
  });

  it('retries a partial file with the same timestamp instead of caching a failed read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-statusline-retry-'));
    const file = join(dir, STATUSLINE_DATA_FILE);
    await writeFile(file, '{');
    const at = (await stat(file)).mtime;
    const seen: AgentLimitRecord[] = [];
    const reader = new ClaudeStatusLineReader(dir, (items) => seen.push(...items));
    try {
      await reader.start();
      expect(seen).toEqual([]);
      await writeFile(file, input({ five_hour: { used_percentage: 37 } }));
      await utimes(file, at, at);
      await reader.read();
      expect(seen).toEqual([expect.objectContaining({ usedPercent: 37 })]);
    } finally {
      reader.stop();
    }
  });
  it('reports the file at start and again when the script replaces it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-statusline-'));
    const file = join(dir, STATUSLINE_DATA_FILE);
    await writeFile(file, input({ five_hour: { used_percentage: 10, resets_at: 2e9 } }));
    const seen: AgentLimitRecord[][] = [];
    const reader = new ClaudeStatusLineReader(dir, (items) => seen.push(items));
    await reader.start();
    try {
      expect(seen).toEqual([[expect.objectContaining({ window: 'five_hour', usedPercent: 10 })]]);
      // Like the script: write a temporary file, then rename it over the data file.
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(`${file}.1.tmp`, input({ five_hour: { used_percentage: 12, resets_at: 2e9 } }));
      await rename(`${file}.1.tmp`, file);
      await vi.waitFor(() => expect(seen.at(-1)).toEqual([expect.objectContaining({ usedPercent: 12 })]), {
        timeout: 3000,
      });
    } finally {
      reader.stop();
    }
  });

  it('reads the files of other accounts and attributes them by the transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oxy-statusline-'));
    const work = '/h/.oxytocin/accounts/claude/work';
    await writeFile(
      join(dir, 'usage-_h__oxytocin_accounts_claude_work.json'),
      JSON.stringify({
        transcript_path: `${work}/projects/-p/s1.jsonl`,
        rate_limits: { five_hour: { used_percentage: 75 } },
      }),
    );
    await writeFile(join(dir, STATUSLINE_DATA_FILE), input({ five_hour: { used_percentage: 28 } }));
    await writeFile(join(dir, 'other.json'), input({ five_hour: { used_percentage: 1 } }));
    const seen: AgentLimitRecord[] = [];
    const reader = new ClaudeStatusLineReader(
      dir,
      (items) => seen.push(...items),
      undefined,
      (path) => (path?.startsWith(work) ? 'acc_work' : 'main'),
    );
    await reader.start();
    reader.stop();
    expect(seen.map((l) => `${l.account}:${l.usedPercent}`).sort()).toEqual(['acc_work:75', 'main:28']);
  });
});
