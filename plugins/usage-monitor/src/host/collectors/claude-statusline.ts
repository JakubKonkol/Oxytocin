import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentLimitRecord } from '../model';

/** File the status line script writes (the last Claude Code status line input that carried `rate_limits`). */
export const STATUSLINE_DATA_FILE = 'usage.json';

/** Windows of `rate_limits` in the status line input and their length in minutes (null: not time-based). */
const WINDOWS: Record<string, number | null> = { five_hour: 300, seven_day: 10080, spend_limit: null };

const WindowSchema = z.object({
  used_percentage: z.number().finite(),
  resets_at: z.number().finite().nullish(),
});
const InputSchema = z.object({ rate_limits: z.record(z.string(), z.unknown()) });

/**
 * Claude subscription limits from Claude Code's status line input (`rate_limits.five_hour` / `seven_day` /
 * `spend_limit`: `used_percentage` 0–100, `resets_at` in epoch seconds). Unknown or malformed input yields nothing.
 */
export function parseStatusLineInput(text: string, observedAt: number): AgentLimitRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const input = InputSchema.safeParse(json);
  if (!input.success) return [];
  const items: AgentLimitRecord[] = [];
  for (const [window, minutes] of Object.entries(WINDOWS)) {
    const w = WindowSchema.safeParse(input.data.rate_limits[window]);
    if (!w.success) continue;
    items.push({
      kind: 'limit',
      agent: 'claude-code',
      window,
      usedPercent: w.data.used_percentage,
      windowMinutes: minutes,
      resetsAt: typeof w.data.resets_at === 'number' ? w.data.resets_at * 1000 : null,
      observedAt,
    });
  }
  return items;
}

const DEBOUNCE_MS = 100;

/**
 * Watches the folder of the status line script and reports the limits in its data file whenever the script
 * replaces it (and once at start). The file's modification time is the time of the reading.
 */
export class ClaudeStatusLineReader {
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastMtime = 0;

  constructor(
    readonly dir: string,
    private readonly onLimits: (items: AgentLimitRecord[]) => void,
    private readonly warn: (message: string, error?: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        if (name && String(name) !== STATUSLINE_DATA_FILE) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.read(), DEBOUNCE_MS);
      });
      this.watcher.on('error', (e) => this.warn('Watching the Claude status line data failed', e));
    } catch (e) {
      this.warn('Watching the Claude status line data failed', e);
    }
    await this.read();
  }

  async read(): Promise<void> {
    const file = join(this.dir, STATUSLINE_DATA_FILE);
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs <= this.lastMtime) return;
      this.lastMtime = mtimeMs;
      const items = parseStatusLineInput(await readFile(file, 'utf8'), Math.round(mtimeMs));
      if (items.length > 0) this.onLimits(items);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.warn('Reading the Claude status line data failed', e);
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}
