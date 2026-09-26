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

/**
 * Samples the process table (one query for all terminals) and reports each terminal's descendants when they
 * change. Every 1 s while any terminal produced output in the last 5 s, otherwise every 5 s; slow cycles
 * (> 250 ms) back off up to 10 s.
 */
export class ProcessMonitor {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly hashes = new Map<string, string>();
  private backoff = 1;
  private stopped = false;
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
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** Runs a sampling cycle now (e.g. right after a terminal was created). */
  poke(): void {
    this.schedule(100);
  }

  async tick(): Promise<void> {
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
    const base = busy ? (this.o.fastMs ?? 1000) : (this.o.slowMs ?? 5000);
    this.schedule(Math.min(base * this.backoff, this.o.maxMs ?? 10_000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
