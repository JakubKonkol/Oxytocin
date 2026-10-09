import type { FileContent, FileEntry, FileList, FileStat } from '../../domain/files';
import type {
  BranchList,
  FileDiffContent,
  GitAction,
  GitActionResult,
  GitInstallation,
  RepoInfo,
  RepoStatus,
} from '../../domain/git';
import type { EnsembleChange, FinishAction } from '../../domain/ensemble';
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
  /** HEAD and working-tree content of a changed file. */
  'git:getFileDiff': (o: { projectId: string; path: string; oldPath?: string; maxBytes: number }) => FileDiffContent;
  /** Stage, discard, commit, push… in a watched project's repository; the status refreshes afterwards. */
  'git:action': (o: { projectId: string; action: GitAction }) => GitActionResult;
  'git:branches': (o: { projectId: string }) => BranchList;
  // Project files (built-in code editor, FILES section). `root` is a project folder; paths are relative to it.
  'files:list': (o: { root: string; path: string; gitPath: string }) => FileEntry[];
  'files:find': (o: { root: string; gitPath: string; ignoredFolders: string[]; limit: number }) => FileList;
  'files:stat': (o: { root: string; path: string }) => FileStat | null;
  'files:read': (o: { root: string; path: string; maxBytes: number }) => FileContent;
  'files:write': (o: {
    root: string;
    path: string;
    content: string;
    bom?: boolean;
    expectedMtimeMs?: number;
  }) => FileStat;
  'files:create': (o: { root: string; path: string; kind: 'file' | 'dir' }) => void;
  'files:rename': (o: { root: string; from: string; to: string }) => void;
  /** Checks an entry may be deleted and returns its absolute path (main moves it to the trash). */
  'files:trashTarget': (o: { root: string; path: string }) => string;
  // Ensemble: worktrees, checkpoints, changes, finishing. Writes are serialized per repository.
  'ensemble:repoInfo': (o: { gitPath: string; cwd: string }) => {
    isRepo: boolean;
    toplevel: string | null;
    branch: string | null;
    head: string | null;
    dirty: number;
    localFiles: string[];
    error?: string;
  };
  'ensemble:addWorktree': (o: {
    gitPath: string;
    repoRoot: string;
    path: string;
    branch: string;
    baseRef?: string;
  }) => { branch: string; baseRef: string; baseCommit: string };
  'ensemble:removeWorktree': (o: { gitPath: string; repoRoot: string; path: string; force: boolean }) => void;
  'ensemble:copyFiles': (o: { from: string; to: string; files: string[] }) => string[];
  'ensemble:commitAll': (o: { gitPath: string; cwd: string; message: string }) => {
    commit: string | null;
    files: number;
  };
  'ensemble:changes': (o: { gitPath: string; cwd: string; base: string; head?: string }) => EnsembleChange[];
  'ensemble:fileAt': (o: {
    gitPath: string;
    cwd: string;
    ref: string;
    path: string;
    maxBytes: number;
  }) => string | null;
  'ensemble:finish': (o: {
    gitPath: string;
    action: FinishAction;
    repoRoot: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    message: string;
    removeWorktree: boolean;
  }) => { detail: string };
  'ensemble:resetTo': (o: { gitPath: string; cwd: string; commit: string }) => void;
};

export type WorkspaceHostEvents = HostBaseEvents & {
  /** Repository discovered or changed (e.g. `git init`, first commit). */
  'git:repo': RepoInfo;
  /** Status relative to HEAD; emitted only when it changed. */
  'git:status': RepoStatus;
  /** Project-relative paths just written (throttled 200 ms) — "live" highlights before the status arrives. */
  'git:fileTouched': { projectId: string; paths: string[]; at: number };
};
