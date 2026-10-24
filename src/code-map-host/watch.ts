import { execFile } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import watcher from '@parcel/watcher';
import type { Disposable } from '@shared/utils/disposable';
import { BUILTIN_FOLDERS, builtInExclusion, toPosix } from './enumerate';
import { hasCode, isInside } from './store/paths';

export async function discoverGitWatchDirectories(root: string, gitPath: string): Promise<string[]> {
  try {
    const results = await Promise.all(
      ['--absolute-git-dir', '--git-common-dir'].map((option) =>
        promisify(execFile)(gitPath, ['--no-optional-locks', 'rev-parse', option], {
          cwd: root,
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 65536,
        }),
      ),
    );
    return [...new Set(results.map((result) => resolve(root, result.stdout.trim())))];
  } catch (error) {
    if (
      hasCode(error, 'ENOENT') ||
      (typeof error === 'object' && error !== null && 'code' in error && error.code === 128)
    )
      return [];
    throw error;
  }
}

export interface PendingChange {
  path: string;
  type: 'create' | 'update' | 'delete';
  sequence: number;
}
export type WatchSubscribe = typeof watcher.subscribe;

/** Registration precedes the initial scan. Changes remain buffered until their build checkpoint is committed. */
export class CodeMapWatch implements Disposable {
  private sequence = 0;
  private readonly pending = new Map<string, PendingChange>();
  private subscriptions: Awaited<ReturnType<WatchSubscribe>>[] = [];
  private disposed = false;
  private unknown = true;
  private committed = 0;
  constructor(
    private readonly root: string,
    private readonly changed: (change: { paths: string[]; reconcile: boolean; sequence: number }) => void,
    private readonly subscribe: WatchSubscribe = watcher.subscribe,
  ) {}

  async start(gitDirectories: readonly string[] = []): Promise<void> {
    const ignore = [...BUILTIN_FOLDERS]
      .filter((folder) => folder !== '.git')
      .flatMap((folder) => [folder, `**/${folder}`, `**/${folder}/**`]);
    ignore.push('.git/objects', '.git/logs', '.git/lfs', '.git/hooks', '.git/modules');
    const receive: Parameters<WatchSubscribe>[1] = (error, events) => {
      if (this.disposed) return;
      if (error) {
        this.unknown = true;
        this.sequence++;
        this.changed({ paths: [], reconcile: true, sequence: this.sequence });
        return;
      }
      const paths: string[] = [];
      let reconcile = false;
      for (const event of events) {
        if (!isInside(this.root, event.path)) continue;
        const path = toPosix(relative(this.root, event.path));
        const parts = path.split('/');
        if (parts.includes('.oxy')) continue;
        if (parts[0] === '.git') {
          if (path === '.git' || /^\.git\/(HEAD|index|packed-refs|refs\/.*)$/.test(path)) {
            this.sequence++;
            reconcile = true;
          }
          continue;
        }
        if (!path || builtInExclusion(path)) continue;
        const change = { path, type: event.type, sequence: ++this.sequence };
        if (this.pending.size < 500 || this.pending.has(path)) this.pending.set(path, change);
        else {
          this.unknown = true;
          reconcile = true;
        }
        if (paths.length < 500) paths.push(path);
        if (
          /(^|\/)(\.gitignore|package\.json|pyproject\.toml|pom\.xml|settings\.gradle(?:\.kts)?|go\.(mod|work)|[jt]sconfig[^/]*\.json)$/.test(
            path,
          )
        )
          reconcile = true;
      }
      if (paths.length || reconcile) this.changed({ paths, reconcile, sequence: this.sequence });
    };
    try {
      this.subscriptions.push(await this.subscribe(this.root, receive, { ignore }));
      for (const directory of gitDirectories.filter((path) => !isInside(this.root, path))) {
        this.subscriptions.push(
          await this.subscribe(
            directory,
            (error, events) => {
              if (error) {
                receive(error, []);
                return;
              }
              if (
                events.some((event) =>
                  /^(HEAD|index|packed-refs|refs\/.*)$/.test(toPosix(relative(directory, event.path))),
                )
              )
                receive(null, [{ path: join(this.root, '.git', 'HEAD'), type: 'update' }]);
            },
            { ignore: ['objects', 'logs', 'hooks', 'lfs', 'modules', 'worktrees'] },
          ),
        );
      }
      if (this.disposed) await this.close();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  checkpoint(): { sequence: number; unknown: boolean; changes: PendingChange[] } {
    return { sequence: this.sequence, unknown: this.unknown, changes: [...this.pending.values()] };
  }
  commit(sequence: number): void {
    for (const [path, change] of this.pending) if (change.sequence <= sequence) this.pending.delete(path);
    if (sequence === this.sequence) this.unknown = false;
    this.committed = Math.max(this.committed, sequence);
  }
  /**
   * The event stream is trustworthy: the initial scan is committed and no overflow or error happened since. Only
   * then does "no pending event" mean "nothing changed".
   */
  get healthy(): boolean {
    return !this.unknown && !this.disposed;
  }
  /** Events newer than the last committed build exist (file changes, or version-control state changes). */
  get dirty(): boolean {
    return this.pending.size > 0 || this.sequence > this.committed;
  }
  get latestSequence(): number {
    return this.sequence;
  }
  /**
   * Records changes found by a metadata probe the same way as watcher events, so the next build covers them and
   * queries wait for it. Paths are checkout-relative.
   */
  observe(paths: readonly string[]): void {
    if (this.disposed || !paths.length) return;
    for (const path of paths) {
      const change: PendingChange = { path, type: 'update', sequence: ++this.sequence };
      if (this.pending.size < 500 || this.pending.has(path)) this.pending.set(path, change);
      else this.unknown = true;
    }
    this.changed({ paths: [...paths].slice(0, 500), reconcile: this.unknown, sequence: this.sequence });
  }
  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    for (const subscription of this.subscriptions.splice(0)) void subscription.unsubscribe().catch(() => undefined);
  }
  async close(): Promise<void> {
    this.disposed = true;
    this.pending.clear();
    await Promise.all(this.subscriptions.splice(0).map((subscription) => subscription.unsubscribe()));
  }
}
