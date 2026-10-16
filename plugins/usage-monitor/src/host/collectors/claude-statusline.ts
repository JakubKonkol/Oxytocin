import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentLimitRecord } from '../model';

/** File the status line script writes (the last Claude Code status line input that carried `rate_limits`). */
export const STATUSLINE_DATA_FILE = 'usage.json';
/** The script's files: `usage.json`, and `usage-<CLAUDE_CONFIG_DIR as a key>.json` for other accounts. */
const DATA_FILE = /^usage(-[A-Za-z0-9_]+)?\.json$/;

/** The session transcript of the status line input: it lies in the folder of the account that ran Claude Code. */
export function transcriptPathOf(text: string): string | undefined {
  try {
    const path = (JSON.parse(text) as { transcript_path?: unknown }).transcript_path;
    return typeof path === 'string' && path ? path : undefined;
  } catch {
    return undefined;
  }
}

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
export function parseStatusLineInput(text: string, observedAt: number, account = 'main'): AgentLimitRecord[] {
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
      account,
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
 * Watches the folder of the status line script and reports the limits in its data files whenever the script replaces
 * one (and once at start). A file's modification time is the time of its reading; the account is the one whose
 * folder holds the session's transcript.
 */
export class ClaudeStatusLineReader {
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly lastMtime = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly onLimits: (items: AgentLimitRecord[]) => void,
    private readonly warn: (message: string, error?: unknown) => void = () => undefined,
    private readonly accountOf: (transcriptPath: string | undefined) => string = () => 'main',
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        if (name && !DATA_FILE.test(String(name))) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.read(), DEBOUNCE_MS);
      });
      this.watcher.on('error', (e) => this.warn('Watching the Claude status line data failed', e));
    } catch (e) {
      this.warn('Watching the Claude status line data failed', e);
    }
    await this.read();
  }

  /** Reads the data files written since the last read. */
  async read(): Promise<void> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => DATA_FILE.test(n));
    for (const name of names) await this.readFile(join(this.dir, name));
  }

  private async readFile(file: string): Promise<void> {
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs <= (this.lastMtime.get(file) ?? 0)) return;
      this.lastMtime.set(file, mtimeMs);
      const text = await readFile(file, 'utf8');
      const items = parseStatusLineInput(text, Math.round(mtimeMs), this.accountOf(transcriptPathOf(text)));
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
