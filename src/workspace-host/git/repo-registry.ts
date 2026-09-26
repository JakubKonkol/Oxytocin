import type { FileDiffContent, RepoInfo, RepoStatus } from '@shared/domain/git';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import type { RefreshReason, WatchRepoRequest } from '@shared/rpc/contracts/workspace-host';
import { computeStatus } from './compute-status';
import { getFileDiff } from './file-diff';
import { discoverRepo } from './discover';
import { RefreshQueue, RefreshScheduler } from './refresh-scheduler';
import { RepoWatcher, type SubscribeFn } from './repo-watcher';

export interface RepoEntry {
  req: WatchRepoRequest;
  info: RepoInfo;
  gitDir?: string;
  commonDir?: string;
  watcher?: RepoWatcher;
  scheduler: RefreshScheduler;
  /** Project-relative path → last write (kept 60 s). */
  touched: Map<string, number>;
  status?: RepoStatus;
  statusKey?: string;
}

export interface RepoRegistryDeps {
  subscribe: SubscribeFn;
  emitRepo: (info: RepoInfo) => void;
  emitTouched: (e: { projectId: string; paths: string[]; at: number }) => void;
  emitStatus?: (status: RepoStatus) => void;
  /** Replaces the status computation (tests). */
  onRefresh?: (entry: RepoEntry, reasons: ReadonlySet<RefreshReason>) => Promise<void>;
  logger: Logger;
}

const sameRequest = (a: WatchRepoRequest, b: WatchRepoRequest) => JSON.stringify(a) === JSON.stringify(b);

/** projectId → watched repository with its refresh scheduler (docs/plan/06-git-changes.md §1). */
export class RepoRegistry {
  private readonly entries = new Map<string, RepoEntry>();
  readonly queue = new RefreshQueue();

  constructor(private readonly deps: RepoRegistryDeps) {}

  get(projectId: string): RepoEntry | undefined {
    return this.entries.get(projectId);
  }

  async watch(req: WatchRepoRequest): Promise<void> {
    const existing = this.entries.get(req.projectId);
    if (existing && sameRequest(existing.req, req)) return;
    if (existing) await this.unwatch(req.projectId);
    const entry: RepoEntry = {
      req,
      info: { projectId: req.projectId, state: 'not-a-repo', hasHead: false, pathspec: null },
      touched: new Map(),
      scheduler: new RefreshScheduler({
        key: req.projectId,
        queue: this.queue,
        run: (reasons) => this.refresh(entry, reasons),
      }),
    };
    this.entries.set(req.projectId, entry);
    entry.scheduler.request('initial');
  }

  async unwatch(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.delete(projectId);
    entry.scheduler.dispose();
    await entry.watcher?.dispose();
  }

  setActive(projectId: string | null): void {
    this.queue.setActive(projectId);
  }

  request(projectId: string, reason: RefreshReason): void {
    this.entries.get(projectId)?.scheduler.request(reason);
  }

  private async rediscover(entry: RepoEntry): Promise<void> {
    const { projectId, gitPath, rootPath } = entry.req;
    let info: RepoInfo;
    try {
      const found = await discoverRepo(gitPath, rootPath);
      if (found.state === 'ok') {
        info = { projectId, state: 'ok', toplevel: found.toplevel, hasHead: found.hasHead, pathspec: found.pathspec };
        entry.gitDir = found.gitDir;
        entry.commonDir = found.commonDir;
      } else {
        info = { projectId, state: 'not-a-repo', hasHead: false, pathspec: null };
        delete entry.gitDir;
        delete entry.commonDir;
      }
    } catch (e) {
      const missing = e instanceof OxyError && e.code === 'GIT_NOT_FOUND';
      info = {
        projectId,
        state: missing ? 'git-missing' : 'error',
        error: e instanceof Error ? e.message : String(e),
        hasHead: false,
        pathspec: null,
      };
    }
    const changedDirs = !entry.watcher || entry.watcher.gitDirs !== `${entry.gitDir ?? ''}|${entry.commonDir ?? ''}`;
    if (JSON.stringify(info) !== JSON.stringify(entry.info)) {
      entry.info = info;
      this.deps.emitRepo(info);
    }
    if (changedDirs && this.entries.get(projectId) === entry && info.state !== 'git-missing')
      await this.startWatcher(entry);
  }

  private async startWatcher(entry: RepoEntry): Promise<void> {
    await entry.watcher?.dispose();
    const watcher = new RepoWatcher({
      root: entry.req.rootPath,
      ...(entry.gitDir ? { gitDir: entry.gitDir } : {}),
      ...(entry.commonDir ? { commonDir: entry.commonDir } : {}),
      ignoredFolders: entry.req.ignoredFolders,
      subscribe: this.deps.subscribe,
      onRefresh: (reason) => entry.scheduler.request(reason),
      onTouched: (paths) => {
        const at = Date.now();
        for (const p of paths) entry.touched.set(p, at);
        this.deps.emitTouched({ projectId: entry.req.projectId, paths, at });
      },
      logger: this.deps.logger,
    });
    entry.watcher = watcher;
    try {
      await watcher.start();
    } catch (e) {
      this.deps.logger.warn(`Cannot watch ${entry.req.rootPath}`, e);
    }
  }

  private async refresh(entry: RepoEntry, reasons: ReadonlySet<RefreshReason>): Promise<void> {
    if (this.entries.get(entry.req.projectId) !== entry) return;
    // Discovery is cheap (two rev-parse calls) but only needed when the repository may have changed shape.
    if (reasons.has('initial') || reasons.has('gitdir') || reasons.has('manual') || entry.info.state !== 'ok') {
      await this.rediscover(entry);
    }
    if (this.deps.onRefresh) {
      if (entry.info.state === 'ok') await this.deps.onRefresh(entry, reasons);
      return;
    }
    await this.computeAndEmit(entry);
  }

  private async computeAndEmit(entry: RepoEntry): Promise<void> {
    const info = entry.info;
    const cutoff = Date.now() - 60_000;
    for (const [path, at] of entry.touched) if (at < cutoff) entry.touched.delete(path);
    let status: RepoStatus;
    if (info.state === 'ok' && info.toplevel) {
      try {
        status = await computeStatus({
          projectId: info.projectId,
          gitPath: entry.req.gitPath,
          toplevel: info.toplevel,
          pathspec: info.pathspec,
          hasHead: info.hasHead,
          maxFiles: entry.req.maxFiles,
          touched: entry.touched,
          ...(entry.status?.headCommit ? { previousHeadCommit: entry.status.headCommit } : {}),
        });
      } catch (e) {
        status = this.emptyStatus(info, 'error', e instanceof Error ? e.message : String(e));
      }
    } else {
      status = this.emptyStatus(info, info.state, info.error);
    }
    if (this.entries.get(info.projectId) !== entry) return;
    // Files that appeared or changed since the last status count as touched even when the watcher missed
    // them (files inside a folder created in the same instant are not always reported).
    const previous = entry.status;
    if (previous?.state === 'ok' && status.state === 'ok') {
      const before = new Map(previous.files.map((f) => [f.path, `${f.status}:${f.additions}:${f.deletions}`]));
      const now = Date.now();
      for (const f of status.files) {
        if (f.touchedAt === undefined && before.get(f.path) !== `${f.status}:${f.additions}:${f.deletions}`) {
          f.touchedAt = now;
          entry.touched.set(f.path, now);
        }
      }
    }
    entry.status = status;
    const { computedAt: _c, durationMs: _d, ...stable } = status;
    const key = JSON.stringify(stable);
    if (key === entry.statusKey) return;
    entry.statusKey = key;
    this.deps.emitStatus?.(status);
  }

  private emptyStatus(info: RepoInfo, state: RepoStatus['state'], error?: string): RepoStatus {
    return {
      projectId: info.projectId,
      state,
      ...(error ? { error } : {}),
      ...(info.toplevel ? { toplevel: info.toplevel } : {}),
      hasHead: info.hasHead,
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      computedAt: Date.now(),
      durationMs: 0,
    };
  }

  async fileDiff(req: {
    projectId: string;
    path: string;
    oldPath?: string;
    maxBytes: number;
  }): Promise<FileDiffContent> {
    const entry = this.entries.get(req.projectId);
    if (!entry) throw new OxyError('NOT_FOUND', `Project ${req.projectId} is not watched`);
    const info = entry.info;
    if (info.state !== 'ok' || !info.toplevel) throw new OxyError('NOT_A_REPO', 'Not a git repository');
    const known = entry.status?.files.find((f) => f.path === req.path);
    const oldPath = req.oldPath ?? known?.oldPath;
    return getFileDiff({
      gitPath: entry.req.gitPath,
      toplevel: info.toplevel,
      pathspec: info.pathspec,
      hasHead: info.hasHead,
      path: req.path,
      ...(oldPath ? { oldPath } : {}),
      // A file that is no longer changed still shows HEAD vs disk (identical sides).
      status: known?.status ?? 'modified',
      maxBytes: req.maxBytes,
    });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.unwatch(id)));
  }
}
