import { readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PANEL_ID_PATTERN,
  type WorkspaceLoadResult,
  type WorkspaceState,
  WorkspaceStateSchema,
} from '@shared/domain/workspace';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { writeFileAtomic } from '../storage/atomic-write';
import { withSeparator } from '../terminals/scrollback-format';

const MAX_SCROLLBACK_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeId(id: string, what: string): void {
  if (!SAFE_ID.test(id)) throw new OxyError('INVALID', `Invalid ${what}: ${id}`);
}

/**
 * Per-project workspace state (dockview layout + panel descriptors) in userData/workspaces/<projectId>.json,
 * plus scrollback snapshots in userData/workspaces/<projectId>/scrollback/<panelId>.vt written at quit.
 */
export class WorkspaceStateService {
  private readonly latest = new Map<string, WorkspaceState>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  private statePath(projectId: string): string {
    assertSafeId(projectId, 'project id');
    return join(this.dir, `${projectId}.json`);
  }

  scrollbackPath(projectId: string, panelId: string): string {
    assertSafeId(projectId, 'project id');
    if (!PANEL_ID_PATTERN.test(panelId)) throw new OxyError('INVALID', `Invalid panel id: ${panelId}`);
    return join(this.dir, projectId, 'scrollback', `${panelId}.vt`);
  }

  async load(projectId: string): Promise<WorkspaceLoadResult> {
    const path = this.statePath(projectId);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: null };
      throw e;
    }
    try {
      const state = WorkspaceStateSchema.parse(JSON.parse(text));
      this.latest.set(projectId, state);
      return { state };
    } catch (e) {
      const corrupt = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(path, corrupt).catch(() => undefined);
      this.logger.warn(`Workspace state of ${projectId} is unreadable; moved to ${corrupt}`, e);
      return { state: null, problem: 'The saved layout could not be read. A default layout was opened.' };
    }
  }

  /** Atomic, serialized per project. */
  save(state: WorkspaceState): Promise<void> {
    this.latest.set(state.projectId, state);
    const path = this.statePath(state.projectId);
    const previous = this.queues.get(state.projectId) ?? Promise.resolve();
    const next = previous
      .then(() => writeFileAtomic(path, `${JSON.stringify(state)}\n`))
      .catch((e: unknown) => this.logger.error(`Failed to save workspace ${state.projectId}`, e));
    this.queues.set(state.projectId, next);
    return next;
  }

  async flush(): Promise<void> {
    await Promise.all(this.queues.values());
  }

  /** The most recently saved or loaded state of every project touched in this session. */
  states(): WorkspaceState[] {
    return [...this.latest.values()];
  }

  async readScrollback(projectId: string, panelId: string): Promise<{ data: string; savedAt: Date } | null> {
    const path = this.scrollbackPath(projectId, panelId);
    try {
      const info = await stat(path);
      if (info.size > MAX_SCROLLBACK_BYTES) return null;
      return { data: await readFile(path, 'utf8'), savedAt: info.mtime };
    } catch {
      return null;
    }
  }

  /**
   * At quit: snapshots every live terminal of every saved workspace (`serialize` returns null for dead ones),
   * stores them next to the state and records the file in the panel descriptor.
   *
   * The quit sequence gives this a time limit, and a slow disk (antivirus scanning each new file on Windows) can
   * use it up. So every snapshot is taken first (in memory), then the files and the states pointing at them are
   * written at the same time: a quit cut short does not leave snapshots behind that no layout refers to.
   */
  async persistScrollback(serialize: (terminalId: string) => Promise<string | null>): Promise<void> {
    const snapshots = await Promise.all(
      this.states().map(async (state) => {
        const terminals: { panelId: string; terminalId: string }[] = [];
        for (const [panelId, d] of Object.entries(state.panels))
          if (d.kind === 'terminal' && d.terminalId && PANEL_ID_PATTERN.test(panelId))
            terminals.push({ panelId, terminalId: d.terminalId });
        const taken = await Promise.all(
          terminals.map(async ({ panelId, terminalId }) => ({
            panelId,
            data: await serialize(terminalId).catch(() => null),
          })),
        );
        return { state, snapshots: taken };
      }),
    );
    const writes: Promise<void>[] = [];
    for (const { state, snapshots: taken } of snapshots) {
      const panels = { ...state.panels };
      let changed = false;
      for (const { panelId, data } of taken) {
        const descriptor = panels[panelId];
        if (data === null || descriptor?.kind !== 'terminal') continue;
        const bytes = Buffer.byteLength(data);
        if (bytes > MAX_SCROLLBACK_BYTES) {
          this.logger.info(`Scrollback of ${panelId} is ${bytes} bytes; not persisted`);
          continue;
        }
        const path = this.scrollbackPath(state.projectId, panelId);
        writes.push(
          writeFileAtomic(path, data).catch((e: unknown) =>
            this.logger.warn(`Failed to persist the scrollback of ${panelId}`, e),
          ),
        );
        panels[panelId] = { ...descriptor, scrollbackFile: `${state.projectId}/scrollback/${panelId}.vt` };
        changed = true;
      }
      if (changed) writes.push(this.save({ ...state, panels, savedAt: Date.now() }));
    }
    await Promise.all(writes);
    await this.flush();
  }

  /** Removes a project's state and snapshots (project removed). */
  async delete(projectId: string): Promise<void> {
    this.latest.delete(projectId);
    await rm(this.statePath(projectId), { force: true });
    await rm(join(this.dir, projectId), { recursive: true, force: true });
  }
}

/** VT data written into a revived terminal: the old buffer, reset modes, then a dimmed separator. */
export function restoredScrollbackData(snapshot: string, at: Date): string {
  const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  return withSeparator(snapshot, `Session restored · ${when}`);
}
