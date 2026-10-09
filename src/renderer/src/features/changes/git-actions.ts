import { create } from 'zustand';
import type { FileChange, GitAction, GitActionKind, GitActionResult } from '@shared/domain/git';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { getSettings } from '../../stores/settings-store';
import { notify } from '../../ui/Toast';

const TITLES: Record<GitActionKind, string> = {
  stage: 'Stage',
  unstage: 'Unstage',
  stageAll: 'Stage all',
  unstageAll: 'Unstage all',
  discard: 'Discard changes',
  discardAll: 'Discard all changes',
  commit: 'Commit',
  undoCommit: 'Undo last commit',
  push: 'Push',
  pull: 'Pull',
  fetch: 'Fetch',
  stash: 'Stash',
  stashPop: 'Pop stash',
  checkout: 'Switch branch',
  createBranch: 'Create branch',
};

/** Actions whose success is worth a toast (the others show in the list right away). */
const ANNOUNCED: Partial<Record<GitActionKind, string>> = {
  push: 'Pushed',
  pull: 'Pulled',
  fetch: 'Fetched',
  stash: 'Changes stashed',
  stashPop: 'Stash applied',
  undoCommit: 'Last commit undone — its changes are staged',
};

interface GitBusyStore {
  /** projectId → the action running now. */
  busy: Record<string, GitActionKind | undefined>;
}

export const useGitBusy = create<GitBusyStore>(() => ({ busy: {} }));

const setBusy = (projectId: string, kind: GitActionKind | undefined) =>
  useGitBusy.setState((s) => ({ busy: { ...s.busy, [projectId]: kind } }));

/**
 * Runs a git action of a project with a busy indicator and a toast when it fails (git's own message). Returns null
 * when it failed.
 */
export async function gitAction(projectId: string, action: GitAction): Promise<GitActionResult | null> {
  setBusy(projectId, action.kind);
  try {
    const result = await ipc.invoke('git:action', { projectId, action });
    const announced = ANNOUNCED[action.kind];
    if (announced) notify('success', announced, result.output ? { description: result.output } : undefined);
    return result;
  } catch (e) {
    notify('error', `${TITLES[action.kind]} failed`, { description: e instanceof Error ? e.message : String(e) });
    return null;
  } finally {
    setBusy(projectId, undefined);
  }
}

const fileCount = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** Discards the changes of files (asks first, unless `git.confirmDiscard` is off). */
export async function discardFiles(projectId: string, files: readonly FileChange[]): Promise<boolean> {
  if (files.length === 0) return false;
  if (getSettings()['git.confirmDiscard']) {
    const created = files.filter((f) => f.status === 'untracked' || f.status === 'added').length;
    const ok = await confirmDialog({
      title:
        files.length === 1
          ? `Discard changes in ${files[0]!.path.split('/').at(-1)}?`
          : `Discard changes in ${fileCount(files.length)}?`,
      description:
        created > 0
          ? `Files are restored to HEAD; ${created === files.length ? (created === 1 ? 'the new file is' : 'the new files are') : `${fileCount(created)} that are new will be`} deleted. This cannot be undone.`
          : 'The files are restored to their last committed version. This cannot be undone.',
      details: files.length > 1 ? files.slice(0, 12).map((f) => f.path) : undefined,
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (!ok) return false;
  }
  return (await gitAction(projectId, { kind: 'discard', paths: files.map((f) => f.path) })) !== null;
}

export async function discardAll(projectId: string, count: number): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Discard all ${fileCount(count)}?`,
    description:
      'Every change since the last commit is lost: modified files are restored, new files are deleted. This cannot be undone.',
    confirmLabel: 'Discard all',
    destructive: true,
  });
  if (!ok) return false;
  return (await gitAction(projectId, { kind: 'discardAll' })) !== null;
}

/** Stages files that are not fully staged, else unstages them (the checkbox of a row or folder). */
export function toggleStaged(projectId: string, files: readonly FileChange[]): Promise<GitActionResult | null> {
  const paths = files.map((f) => f.path);
  const allStaged = files.every((f) => f.staged && !f.unstaged);
  return gitAction(projectId, allStaged ? { kind: 'unstage', paths } : { kind: 'stage', paths });
}

/** Staged state of a group of files: every change staged, some, or none. */
export function stageState(files: readonly Pick<FileChange, 'staged' | 'unstaged'>[]): 'all' | 'some' | 'none' {
  if (files.length === 0) return 'none';
  const full = files.filter((f) => f.staged && !f.unstaged).length;
  if (full === files.length) return 'all';
  return files.some((f) => f.staged) ? 'some' : 'none';
}

export async function undoLastCommit(projectId: string, subject?: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Undo the last commit?',
    description: `${subject ? `"${subject}" is removed from the branch; ` : 'The commit is removed from the branch; '}its changes stay in your files, staged. If the commit was pushed, the branch will differ from its upstream.`,
    confirmLabel: 'Undo commit',
    tone: 'warning',
  });
  if (ok) await gitAction(projectId, { kind: 'undoCommit' });
}
