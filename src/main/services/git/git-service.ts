import type { FileDiffContent, FileDiffRequest, GitInstallation, RepoInfo, RepoStatus } from '@shared/domain/git';
import { OxyError } from '@shared/errors';
import type { Project } from '@shared/domain/project';
import type { Settings } from '@shared/domain/settings';
import type { Logger } from '@shared/logging/logger';
import type { RefreshReason, WorkspaceHostEvents, WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { UtilityHost } from '../../hosts/utility-host';

export interface GitServiceDeps {
  host: Pick<UtilityHost<WorkspaceHostMethods, WorkspaceHostEvents>, 'call' | 'onEvent' | 'onDidBecomeReady'>;
  projects: {
    list(): Project[];
    activeId: () => string | null;
    onDidChange: (listener: (projects: Project[]) => void) => Disposable;
    onDidChangeActive: (listener: (id: string | null) => void) => Disposable;
  };
  settings: () => Settings;
  onDidChangeSettings: (listener: (s: Settings) => void) => Disposable;
  isWindowFocused: () => boolean;
  logger: Logger;
}

/**
 * Main-side git coordination (docs/plan/06-git-changes.md §1): which projects are watched by the Workspace
 * Host, the active project's priority, focus and periodic refreshes, and the latest repository info.
 */
export class GitService implements Disposable {
  private readonly store = new DisposableStore();
  private readonly watched = new Map<string, string>();
  private readonly repos = new Map<string, RepoInfo>();
  private readonly statuses = new Map<string, RepoStatus>();
  private readonly statusEmitter = new Emitter<RepoStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  private installation: GitInstallation | null | undefined;
  private periodic: ReturnType<typeof setInterval> | undefined;
  private readonly repoEmitter = new Emitter<RepoInfo>();
  readonly onDidChangeRepo = this.repoEmitter.event;
  private readonly touchedEmitter = new Emitter<WorkspaceHostEvents['git:fileTouched']>();
  readonly onDidTouchFiles = this.touchedEmitter.event;

  constructor(private readonly deps: GitServiceDeps) {
    this.store.add(
      deps.host.onEvent('git:repo', (info) => {
        this.repos.set(info.projectId, info);
        this.repoEmitter.fire(info);
      }),
    );
    this.store.add(deps.host.onEvent('git:fileTouched', (e) => this.touchedEmitter.fire(e)));
    this.store.add(
      deps.host.onEvent('git:status', (status) => {
        if (!this.watched.has(status.projectId)) return;
        this.statuses.set(status.projectId, status);
        this.statusEmitter.fire(status);
      }),
    );
    this.store.add(deps.projects.onDidChange(() => void this.sync()));
    this.store.add(
      deps.projects.onDidChangeActive((id) => {
        // sync() also tells the host which project is active.
        void this.sync().then(() => {
          if (id) this.refresh(id, 'focus');
        });
      }),
    );
    this.store.add(
      deps.onDidChangeSettings(() => {
        this.installation = undefined;
        this.restartPeriodic();
        void this.sync();
      }),
    );
    this.store.add(
      deps.host.onDidBecomeReady(({ restarted }) => {
        if (!restarted) return;
        // The Workspace Host lost its watchers: start them again.
        this.watched.clear();
        void this.sync();
      }),
    );
  }

  start(): void {
    this.restartPeriodic();
    void this.sync();
  }

  git(): GitInstallation | null | undefined {
    return this.installation;
  }

  repo(projectId: string): RepoInfo | undefined {
    return this.repos.get(projectId);
  }

  /** Latest status of a project (null when not watched or not computed yet). */
  status(projectId: string): RepoStatus | null {
    const cached = this.statuses.get(projectId);
    if (cached) return cached;
    const info = this.repos.get(projectId);
    // Git missing: the host never computes anything for the project.
    if (info?.state === 'git-missing') {
      return {
        projectId,
        state: 'git-missing',
        hasHead: false,
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        computedAt: Date.now(),
        durationMs: 0,
      };
    }
    return null;
  }

  private gitPath(): string {
    return this.deps.settings()['git.path'] ?? 'git';
  }

  private async call<K extends keyof WorkspaceHostMethods>(
    method: K,
    params: Parameters<WorkspaceHostMethods[K]>[0],
  ): Promise<Awaited<ReturnType<WorkspaceHostMethods[K]>> | undefined> {
    try {
      return (await this.deps.host.call(method, params as never)) as Awaited<ReturnType<WorkspaceHostMethods[K]>>;
    } catch (e) {
      this.deps.logger.debug(`Workspace Host ${String(method)} failed`, e);
      return undefined;
    }
  }

  private async detect(): Promise<GitInstallation | null> {
    if (this.installation !== undefined) return this.installation;
    const found = (await this.call('git:detect', { gitPath: this.gitPath() })) ?? null;
    this.installation = found;
    if (!found) this.deps.logger.warn(`git not found (${this.gitPath()})`);
    else if (!found.supported) this.deps.logger.warn(`git ${found.version} is older than 2.30; some features may fail`);
    else this.deps.logger.info(`Using git ${found.version}`);
    return found;
  }

  /** Projects to watch: all (default) or only the active one; none when git is disabled. */
  private wanted(): Project[] {
    const s = this.deps.settings();
    if (!s['git.enabled']) return [];
    const projects = this.deps.projects.list().filter((p) => !p.missing && p.settings.git?.enabled !== false);
    if (s['git.watchInactiveProjects']) return projects;
    const active = this.deps.projects.activeId();
    return projects.filter((p) => p.id === active);
  }

  private syncing: Promise<void> = Promise.resolve();

  /** Brings the Workspace Host's watchers in line with the projects and settings. */
  sync(): Promise<void> {
    this.syncing = this.syncing
      .then(() => this.doSync())
      .catch((e: unknown) => this.deps.logger.warn('git sync failed', e));
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const git = await this.detect();
    const wanted = this.wanted();
    const s = this.deps.settings();
    const keep = new Set<string>();
    for (const p of wanted) {
      keep.add(p.id);
      if (!git) {
        const info: RepoInfo = { projectId: p.id, state: 'git-missing', hasHead: false, pathspec: null };
        if (this.repos.get(p.id)?.state !== 'git-missing') {
          this.repos.set(p.id, info);
          this.repoEmitter.fire(info);
          const status = this.status(p.id);
          if (status) this.statusEmitter.fire(status);
        }
        continue;
      }
      const req = {
        projectId: p.id,
        rootPath: p.rootPath,
        gitPath: git.path,
        ignoredFolders: [...s['git.ignoredFolders'], ...(p.settings.git?.ignoredFolders ?? [])],
        maxFiles: s['git.maxFiles'],
      };
      const key = JSON.stringify(req);
      if (this.watched.get(p.id) === key) continue;
      this.watched.set(p.id, key);
      await this.call('git:watch', req);
    }
    for (const id of [...this.watched.keys()]) {
      if (keep.has(id)) continue;
      this.watched.delete(id);
      this.repos.delete(id);
      this.statuses.delete(id);
      await this.call('git:unwatch', { projectId: id });
    }
    await this.call('git:setActive', { projectId: this.deps.projects.activeId() });
  }

  async fileDiff(req: FileDiffRequest): Promise<FileDiffContent> {
    if (!this.watched.has(req.projectId)) throw new OxyError('NOT_FOUND', 'The project is not watched by git');
    const maxBytes = Math.round(this.deps.settings()['git.diff.maxFileSizeMb'] * 1024 * 1024);
    return await this.deps.host.call('git:getFileDiff', { ...req, maxBytes });
  }

  refresh(projectId: string, reason: RefreshReason): void {
    if (!this.watched.has(projectId)) return;
    void this.call('git:refresh', { projectId, reason });
  }

  /** Window focus → refresh the active project (docs/plan/06-git-changes.md §3.3). */
  onWindowFocus(): void {
    const active = this.deps.projects.activeId();
    if (active) this.refresh(active, 'focus');
  }

  private restartPeriodic(): void {
    if (this.periodic) clearInterval(this.periodic);
    const seconds = this.deps.settings()['git.periodicRefreshSeconds'];
    if (seconds <= 0) return;
    this.periodic = setInterval(() => {
      const active = this.deps.projects.activeId();
      if (active && this.deps.isWindowFocused()) this.refresh(active, 'periodic');
    }, seconds * 1000);
  }

  dispose(): void {
    if (this.periodic) clearInterval(this.periodic);
    this.store.dispose();
    this.repoEmitter.dispose();
    this.touchedEmitter.dispose();
    this.statusEmitter.dispose();
  }
}
