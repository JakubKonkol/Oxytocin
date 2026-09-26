import { execFile } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentState } from '@shared/domain/agent';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';

/** `~/.claude/sessions/<pid>.json` — undocumented, so parsed tolerantly (spike S5). */
const RegistryEntrySchema = z
  .object({
    pid: z.number(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    waitingFor: z.string().optional(),
    updatedAt: z.number().optional(),
    statusUpdatedAt: z.number().optional(),
  })
  .passthrough();

export interface RegistryEntry {
  pid: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
}

/** Registry status → agent state (docs/plan/04-terminals.md §9.3). */
export function mapRegistryStatus(status: string | undefined): AgentState {
  switch (status) {
    case 'busy':
    case 'shell':
      return 'working';
    case 'idle':
      return 'idle';
    case 'waiting':
      return 'waiting';
    default:
      return 'unknown';
  }
}

export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  const parsed = RegistryEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    pid: d.pid,
    ...(d.sessionId ? { sessionId: d.sessionId } : {}),
    ...(d.cwd ? { cwd: d.cwd } : {}),
    ...(d.name ? { name: d.name } : {}),
    ...(d.status ? { status: d.status } : {}),
    ...(d.waitingFor ? { waitingFor: d.waitingFor } : {}),
  };
}

export interface ClaudeRegistryOptions {
  dir: string;
  logger: Logger;
  rescanMs?: number;
  /** Fallback when the directory does not exist: `claude agents --json` (only while Claude agents run). */
  cliFallback?: () => Promise<unknown[] | null>;
}

export function claudeAgentsCli(claudeBinary = 'claude'): () => Promise<unknown[] | null> {
  return () =>
    new Promise((resolve) => {
      execFile(claudeBinary, ['agents', '--json'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const parsed: unknown = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : null);
        } catch {
          resolve(null);
        }
      });
    });
}

/** Watches the Claude Code session registry and exposes entries by pid. */
export class ClaudeRegistry implements Disposable {
  private entries = new Map<number, RegistryEntry>();
  private watcher: FSWatcher | undefined;
  private rescanTimer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly unknownStatuses = new Set<string>();
  /** Set by the AgentService: whether any Claude agent runs (enables the CLI fallback). */
  hasClaudeAgents = false;
  private usingCli = false;

  private dir: string;

  constructor(private readonly o: ClaudeRegistryOptions) {
    this.dir = o.dir;
  }

  /** Switches the watched directory (CLAUDE_CONFIG_DIR resolved from the login shell). */
  setDir(dir: string): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.watcher?.close();
    this.watcher = undefined;
  }

  get(pid: number): RegistryEntry | undefined {
    return this.entries.get(pid);
  }

  start(): void {
    void this.rescan();
    // Until the directory can be watched (it appears when Claude Code first runs) it is checked every second;
    // afterwards a full rescan every 15 s covers lost watch events. The CLI fallback polls every 5 s.
    const rescanMs = this.o.rescanMs ?? 15_000;
    let last = Date.now();
    this.rescanTimer = setInterval(() => {
      const interval = this.usingCli ? 5000 : this.watcher ? rescanMs : 1000;
      if (Date.now() - last < interval) return;
      last = Date.now();
      void this.rescan();
    }, 1000);
    this.tryWatch();
  }

  private tryWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.rescan(), 50);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // The directory appears once Claude Code runs for the first time; retried on each rescan.
    }
  }

  async rescan(): Promise<void> {
    const next = new Map<number, RegistryEntry>();
    const exists = await stat(this.dir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (exists) {
      this.tryWatch();
      const files = await readdir(this.dir).catch(() => [] as string[]);
      await Promise.all(
        files
          .filter((f) => /^\d+\.json$/.test(f))
          .map(async (f) => {
            try {
              const entry = parseRegistryEntry(JSON.parse(await readFile(join(this.dir, f), 'utf8')));
              if (entry) next.set(entry.pid, entry);
            } catch {
              // partially written file — picked up by the next event
            }
          }),
      );
    }
    this.usingCli = !exists && this.hasClaudeAgents && this.o.cliFallback !== undefined;
    if (this.usingCli && this.o.cliFallback) {
      for (const raw of (await this.o.cliFallback()) ?? []) {
        const entry = parseRegistryEntry(raw);
        if (entry) next.set(entry.pid, entry);
      }
    }
    for (const e of next.values()) {
      if (e.status && mapRegistryStatus(e.status) === 'unknown' && !this.unknownStatuses.has(e.status)) {
        this.unknownStatuses.add(e.status);
        this.o.logger.debug(`Unknown Claude Code session status "${e.status}"`);
      }
    }
    const before = JSON.stringify([...this.entries]);
    this.entries = next;
    if (JSON.stringify([...next]) !== before) this.emitter.fire();
  }

  dispose(): void {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.emitter.dispose();
  }
}
