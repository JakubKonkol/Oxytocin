import type { ProcInfo } from '@shared/domain/terminal';
import type { Logger } from '@shared/logging/logger';
import { posixSource, type ProcessSource, type ProcRow, windowsSource } from './sources';

/** Helper processes that never count as "a process running in the terminal". */
const IGNORED = /^(conhost|OpenConsole|wslhost|wsl|gitstatusd.*|starship)(\.exe)?$/i;

export interface MonitoredTerminal {
  id: string;
  pid: number;
  lastOutputAt: number;
}

export interface TerminalProcesses {
  id: string;
  descendants: ProcInfo[];
  foreground?: ProcInfo;
}

/** Descendants of `root` in breadth-first order (nearest first), without ignored helpers. */
export function descendantsOf(root: number, rows: readonly ProcRow[]): ProcInfo[] {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const out: ProcInfo[] = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      if (!IGNORED.test(child.name))
        out.push({ pid: child.pid, ppid: child.ppid, name: child.name, commandLine: child.commandLine });
    }
  }
  return out;
}

/**
 * Sampling interval while terminals produce output. Each Windows sample spawns `fastlist.exe` (~40 ms of CPU),
 * and agents print continuously (spinners), so Windows samples every 2 s instead of every second.
 */
export function busySampleMs(platform: NodeJS.Platform = process.platform): number {
  return platform === 'win32' ? 2000 : 1000;
}

export interface ProcessMonitorOptions {
  source?: ProcessSource;
  terminals: () => MonitoredTerminal[];
  onChange: (update: TerminalProcesses) => void;
  logger: Logger;
  now?: () => number;
  fastMs?: number;
  slowMs?: number;
  maxMs?: number;
}

/** After a shell integration command start, sample this often for `COMMAND_BURST_MS` (the command's process appears). */
export const COMMAND_SAMPLE_MS = 400;
export const COMMAND_BURST_MS = 3000;

/**
 * Samples the process table (one query for all terminals) and reports each terminal's descendants when they
 * change. Every `busySampleMs()` (1 s, 2 s on Windows) while any terminal produced output in the last 5 s, otherwise
 * every 5 s; every `COMMAND_SAMPLE_MS` for a few seconds after a command started. Slow cycles (> 250 ms) back off up
 * to 10 s.
 */
export class ProcessMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt = 0;
  private running = false;
  private readonly hashes = new Map<string, string>();
  private backoff = 1;
  private stopped = false;
  /** Shortest nudge requested while a sample was running; applied when it finishes. */
  private pendingNudgeMs: number | undefined;
  private burstUntil = 0;
  private readonly source: ProcessSource;
  private readonly now: () => number;

  constructor(private readonly o: ProcessMonitorOptions) {
    this.source = o.source ?? (process.platform === 'win32' ? windowsSource() : posixSource());
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.schedule(200);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.now() + ms;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Samples within `withinMs` unless a sample is already due sooner (user pressed Enter, output resumed). */
  nudge(withinMs: number): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingNudgeMs = Math.min(this.pendingNudgeMs ?? withinMs, withinMs);
      return;
    }
    if (this.nextAt - this.now() > withinMs) this.schedule(withinMs);
  }

  /**
   * A command started (shell integration): its process shows up within moments, so sample quickly for a few
   * seconds instead of waiting for the next busy cycle (2 s on Windows).
   */
  commandStarted(): void {
    this.burstUntil = this.now() + COMMAND_BURST_MS;
    this.nudge(COMMAND_SAMPLE_MS);
  }

  /** Runs a sampling cycle now (e.g. right after a terminal was created). */
  poke(): void {
    this.schedule(100);
  }

  async tick(): Promise<void> {
    this.running = true;
    try {
      await this.sample();
    } finally {
      this.running = false;
    }
  }

  private async sample(): Promise<void> {
    const terminals = this.o.terminals();
    if (terminals.length === 0) {
      this.hashes.clear();
      this.schedule(this.o.slowMs ?? 5000);
      return;
    }
    const started = this.now();
    try {
      const rows = await this.source.list(terminals.map((t) => t.pid));
      const live = new Set(terminals.map((t) => t.id));
      for (const id of this.hashes.keys()) if (!live.has(id)) this.hashes.delete(id);
      for (const t of terminals) {
        const descendants = descendantsOf(t.pid, rows);
        const hash = descendants.map((d) => `${d.pid}:${d.name}`).join('|');
        if (this.hashes.get(t.id) === hash) continue;
        this.hashes.set(t.id, hash);
        const foreground = descendants[0];
        this.o.onChange(foreground ? { id: t.id, descendants, foreground } : { id: t.id, descendants });
      }
    } catch (e) {
      this.o.logger.debug('Process sampling failed', e);
    }
    const cost = this.now() - started;
    this.backoff = cost > 250 ? Math.min(this.backoff * 2, 10) : 1;
    const busy = terminals.some((t) => this.now() - t.lastOutputAt < 5000);
    const base = busy ? (this.o.fastMs ?? busySampleMs()) : (this.o.slowMs ?? 5000);
    let next = Math.min(base * this.backoff, this.o.maxMs ?? 10_000);
    if (this.now() < this.burstUntil) next = Math.min(next, COMMAND_SAMPLE_MS);
    if (this.pendingNudgeMs !== undefined) next = Math.min(next, this.pendingNudgeMs);
    this.pendingNudgeMs = undefined;
    this.schedule(next);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
