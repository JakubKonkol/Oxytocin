import { appendFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type EnsembleRecord, EnsembleRecordSchema, type RunEvent } from '@shared/domain/ensemble';
import type { Logger } from '@shared/logging/logger';
import { writeFileAtomic } from '../storage/atomic-write';

const SAVE_DEBOUNCE_MS = 300;

/**
 * Tasks and their runs: `<dir>/tasks/<taskId>.json` (atomic writes after every change, debounced) and an artifacts
 * folder `<dir>/tasks/<taskId>/` (prompt files, MCP configs of running agents, `events.jsonl` with the full timeline).
 */
export class EnsembleStore {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, EnsembleRecord>();
  private readonly writing = new Map<string, Promise<void>>();
  /** Events already appended to events.jsonl, per task. */
  private readonly appended = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  get tasksDir(): string {
    return join(this.dir, 'tasks');
  }

  artifactsDir(taskId: string): string {
    return join(this.tasksDir, taskId);
  }

  async loadAll(): Promise<EnsembleRecord[]> {
    const files = await readdir(this.tasksDir).catch(() => [] as string[]);
    const out: EnsembleRecord[] = [];
    for (const file of files.filter((f) => /^[a-z0-9-]+\.json$/.test(f))) {
      const path = join(this.tasksDir, file);
      try {
        const parsed = EnsembleRecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid');
        out.push(parsed.data);
        this.appended.set(parsed.data.task.id, parsed.data.run.eventCount);
      } catch (e) {
        // Never lose a task silently: the file is kept next to the others for inspection.
        this.logger.warn(`Ensemble task ${file} could not be read; moved aside`, e);
        await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined);
      }
    }
    return out;
  }

  /** Saves a record (debounced; `flush` writes at once). */
  save(record: EnsembleRecord): void {
    const id = record.task.id;
    this.pending.set(id, record);
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.write(id);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private async write(id: string): Promise<void> {
    const previous = this.writing.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const record = this.pending.get(id);
      if (!record) return;
      this.pending.delete(id);
      try {
        await this.appendEvents(record);
        await writeFileAtomic(join(this.tasksDir, `${id}.json`), JSON.stringify(record));
      } catch (e) {
        this.logger.error(`Saving Ensemble task ${id} failed`, e);
      }
    });
    this.writing.set(id, next);
    await next;
  }

  /** The complete timeline goes to events.jsonl (the run keeps only the latest events). */
  private async appendEvents(record: EnsembleRecord): Promise<void> {
    const id = record.task.id;
    const done = this.appended.get(id) ?? 0;
    const fresh: RunEvent[] = record.run.events.filter((e) => e.id > done);
    if (fresh.length === 0) {
      if (record.run.eventCount < done) this.appended.set(id, record.run.eventCount);
      return;
    }
    await mkdir(this.artifactsDir(id), { recursive: true });
    await appendFile(
      join(this.artifactsDir(id), 'events.jsonl'),
      fresh.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    this.appended.set(id, fresh.at(-1)!.id);
  }

  async flush(): Promise<void> {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
      void this.write(id);
    }
    await Promise.all(this.writing.values());
  }

  async remove(taskId: string): Promise<void> {
    clearTimeout(this.timers.get(taskId));
    this.timers.delete(taskId);
    this.pending.delete(taskId);
    await this.writing.get(taskId);
    this.appended.delete(taskId);
    await rm(join(this.tasksDir, `${taskId}.json`), { force: true });
    await rm(this.artifactsDir(taskId), { recursive: true, force: true }).catch(() => undefined);
  }
}
