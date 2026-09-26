import type { GitInstallation, RepoInfo, RepoStatus } from '../../domain/git';
import type { HostBaseEvents, HostBaseMethods } from './host-base';

export type RefreshReason = 'fs' | 'gitdir' | 'manual' | 'focus' | 'periodic' | 'initial';

export interface WatchRepoRequest {
  projectId: string;
  rootPath: string;
  gitPath: string;
  ignoredFolders: string[];
  /** `git.maxFiles`: larger change lists are truncated. */
  maxFiles: number;
}

export type WorkspaceHostMethods = HostBaseMethods & {
  /** `git --version` for the configured binary; null when git cannot run. */
  'git:detect': (o: { gitPath: string }) => GitInstallation | null;
  /** Starts (or restarts, when parameters changed) watching a project's repository. */
  'git:watch': (o: WatchRepoRequest) => void;
  'git:unwatch': (o: { projectId: string }) => void;
  /** The active project's refreshes go first. */
  'git:setActive': (o: { projectId: string | null }) => void;
  'git:refresh': (o: { projectId: string; reason: RefreshReason }) => void;
  /** Latest computed status (null before the first refresh). */
  'git:getStatus': (o: { projectId: string }) => RepoStatus | null;
};

export type WorkspaceHostEvents = HostBaseEvents & {
  /** Repository discovered or changed (e.g. `git init`, first commit). */
  'git:repo': RepoInfo;
  /** Status relative to HEAD; emitted only when it changed. */
  'git:status': RepoStatus;
  /** Project-relative paths just written (throttled 200 ms) — "live" highlights before the status arrives. */
  'git:fileTouched': { projectId: string; paths: string[]; at: number };
};
