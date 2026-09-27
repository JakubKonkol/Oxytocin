import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentLimitRecord } from '../model';
import { ClaudeStatusLineReader, parseStatusLineInput, STATUSLINE_DATA_FILE } from './claude-statusline';

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
});
