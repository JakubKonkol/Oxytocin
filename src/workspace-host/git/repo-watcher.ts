import { relative, sep } from 'node:path';
import type { Logger } from '@shared/logging/logger';
import type { RefreshReason } from './refresh-scheduler';

export interface WatchEvent {
  path: string;
  type: 'create' | 'update' | 'delete';
}

export type SubscribeFn = (
  dir: string,
  onEvents: (err: Error | null, events: WatchEvent[]) => void,
  opts: { ignore: string[] },
) => Promise<{ unsubscribe(): Promise<void> }>;

export interface RepoWatcherOptions {
  /** Project root (watched tree). */
  root: string;
  /** Git directory and common directory (refs); watched separately when outside `root`. */
  gitDir?: string;
  commonDir?: string;
  ignoredFolders: readonly string[];
  subscribe: SubscribeFn;
  onRefresh: (reason: RefreshReason) => void;
  /** Project-relative paths ('/' separators) written recently; throttled. */
  onTouched: (paths: string[]) => void;
  logger: Logger;
  touchedThrottleMs?: number;
}

const ALWAYS_IGNORED_IN_GIT = ['objects', 'logs', 'lfs', 'hooks', 'info', 'modules'];

/** Files in the git directory whose change means HEAD, the index or refs moved. */
const GITDIR_RELEVANT =
  /^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|packed-refs|REBASE_[A-Z_]+|refs\/.+|rebase-(merge|apply)(\/.*)?)$/;

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
};

const toPosix = (p: string) => p.split(sep).join('/');

/** Ignore patterns for @parcel/watcher: the folder at the root and at any depth. */
export function ignorePatterns(folders: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of folders) {
    const clean = f.replace(/[\\/]+$/, '');
    if (!clean) continue;
    out.push(clean, `**/${clean}`, `**/${clean}/**`);
  }
  return out;
}

/**
 * Watches a project's working tree and git directory (docs/plan/06-git-changes.md §3.1): working-tree events
 * request an `fs` refresh and report touched paths, relevant git-directory events (HEAD, index, refs) a
 * `gitdir` refresh.
 */
export class RepoWatcher {
  private subs: { unsubscribe(): Promise<void> }[] = [];
  private touched = new Set<string>();
  private touchTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTouchEmit = 0;
  private disposed = false;

  /** Identity of the watched git directories (restart the watcher when they change). */
  readonly gitDirs: string;

  constructor(private readonly o: RepoWatcherOptions) {
    this.gitDirs = `${o.gitDir ?? ''}|${o.commonDir ?? ''}`;
  }

  async start(): Promise<void> {
    const gitDirs = [this.o.gitDir, this.o.commonDir].filter((d): d is string => !!d);
    const inRoot = gitDirs.filter((d) => isInside(d, this.o.root));
    const rootIgnore = [
      ...ignorePatterns(this.o.ignoredFolders),
      ...inRoot.flatMap((d) => ALWAYS_IGNORED_IN_GIT.map((sub) => toPosix(relative(this.o.root, `${d}${sep}${sub}`)))),
    ];
    this.subs.push(
      await this.o.subscribe(this.o.root, (err, events) => this.onEvents(err, events), { ignore: rootIgnore }),
    );
    const outside = [...new Set(gitDirs.filter((d) => !isInside(d, this.o.root)))];
    for (const dir of outside) {
      // A linked worktree's git dir or a monorepo's .git outside the project folder.
      const ignore = [...ALWAYS_IGNORED_IN_GIT, 'worktrees'];
      this.subs.push(await this.o.subscribe(dir, (err, events) => this.onEvents(err, events), { ignore }));
    }
    if (this.disposed) await this.dispose();
  }

  /** Git-directory relative path when `path` is inside one, else null. */
  private gitRelative(path: string): string | null {
    for (const dir of [this.o.gitDir, this.o.commonDir]) {
      if (dir && isInside(path, dir)) return toPosix(relative(dir, path));
    }
    return null;
  }

  private onEvents(err: Error | null, events: WatchEvent[]): void {
    if (this.disposed) return;
    if (err) {
      this.o.logger.warn(`Watcher error in ${this.o.root}: ${err.message}`);
      this.o.onRefresh('fs');
      return;
    }
    let fs = false;
    let git = false;
    for (const e of events) {
      const inGit = this.gitRelative(e.path);
      if (inGit !== null) {
        if (!inGit.endsWith('.lock') && GITDIR_RELEVANT.test(inGit)) git = true;
        continue;
      }
      if (!isInside(e.path, this.o.root)) continue;
      fs = true;
      this.touched.add(toPosix(relative(this.o.root, e.path)));
    }
    if (git) this.o.onRefresh('gitdir');
    else if (fs) this.o.onRefresh('fs');
    if (fs) this.scheduleTouched();
  }

  private scheduleTouched(): void {
    if (this.touchTimer) return;
    const throttle = this.o.touchedThrottleMs ?? 200;
    const wait = Math.max(0, this.lastTouchEmit + throttle - Date.now());
    this.touchTimer = setTimeout(() => {
      this.touchTimer = undefined;
      this.lastTouchEmit = Date.now();
      const paths = [...this.touched];
      this.touched.clear();
      if (paths.length > 0) this.o.onTouched(paths.slice(0, 500));
    }, wait);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.touchTimer) clearTimeout(this.touchTimer);
    const subs = this.subs;
    this.subs = [];
    await Promise.all(subs.map((s) => s.unsubscribe().catch(() => undefined)));
  }
}
