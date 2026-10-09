import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EnsembleChange, FinishAction } from '@shared/domain/ensemble';
import { OxyError } from '@shared/errors';
import { runGit } from './exec';
import { serialized } from './serialize';

/**
 * Git operations of Ensemble (Plan 03): worktrees, checkpoint commits, the task's changes and finishing a task.
 * Reads use `--no-optional-locks` (runGit); writes take git's locks, so they are serialized per repository.
 */

async function git(gitPath: string, cwd: string, args: string[], timeoutMs = 60_000) {
  const r = await runGit(gitPath, args, { cwd, timeoutMs });
  return { code: r.code, out: r.stdout.toString('utf8'), err: r.stderr };
}

async function gitOk(gitPath: string, cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await git(gitPath, cwd, args, timeoutMs);
  if (r.code !== 0)
    throw new OxyError('UNAVAILABLE', `git ${args[0]} failed: ${(r.err || r.out).trim().slice(0, 800)}`);
  return r.out;
}

/** Checkpoints are committed with the user's identity, or Oxytocin's when git has none. */
async function identityArgs(gitPath: string, cwd: string): Promise<string[]> {
  const [name, email] = await Promise.all([
    git(gitPath, cwd, ['config', 'user.name']),
    git(gitPath, cwd, ['config', 'user.email']),
  ]);
  const args: string[] = [];
  if (name.code !== 0 || !name.out.trim()) args.push('-c', 'user.name=Oxytocin Ensemble');
  if (email.code !== 0 || !email.out.trim()) args.push('-c', 'user.email=ensemble@oxytocin.local');
  return args;
}

export interface RepoInfoResult {
  isRepo: boolean;
  toplevel: string | null;
  branch: string | null;
  head: string | null;
  /** Changed files in the checkout (porcelain lines). */
  dirty: number;
  /** Untracked or ignored files that look like local configuration (".env", "appsettings.Development.json"). */
  localFiles: string[];
  error?: string;
}

const LOCAL_FILE = /^(\.env(\..+)?|appsettings\..+\.json|.+\.local(\..+)?|local\.settings\.json|\.npmrc|\.dev\.vars)$/i;

export async function repoInfo(gitPath: string, cwd: string): Promise<RepoInfoResult> {
  const top = await git(gitPath, cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0)
    return {
      isRepo: false,
      toplevel: null,
      branch: null,
      head: null,
      dirty: 0,
      localFiles: [],
      error: top.err.trim().slice(0, 300),
    };
  const toplevel = resolve(top.out.trim());
  const [branch, head, status] = await Promise.all([
    git(gitPath, toplevel, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(gitPath, toplevel, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(gitPath, toplevel, ['status', '--porcelain=v1', '--untracked-files=normal']),
  ]);
  const entries = await readdir(toplevel).catch(() => [] as string[]);
  return {
    isRepo: true,
    toplevel,
    branch: branch.code === 0 ? branch.out.trim() || null : null,
    head: head.code === 0 ? head.out.trim() || null : null,
    dirty: status.out.split('\n').filter((l) => l.trim()).length,
    localFiles: entries.filter((f) => LOCAL_FILE.test(f)).sort(),
  };
}

async function branchExists(gitPath: string, repo: string, branch: string): Promise<boolean> {
  return (await git(gitPath, repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

/** Creates a worktree on a new branch (a free name: `name`, `name-2`, …) from `baseRef`. */
export function addWorktree(o: {
  gitPath: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseRef?: string | undefined;
}): Promise<{ branch: string; baseRef: string; baseCommit: string }> {
  return serialized(o.repoRoot, async () => {
    const check = await git(o.gitPath, o.repoRoot, ['check-ref-format', '--branch', o.branch]);
    if (check.code !== 0) throw new OxyError('INVALID', `"${o.branch}" is not a valid branch name.`);
    const head = await git(o.gitPath, o.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code !== 0)
      throw new OxyError('UNAVAILABLE', 'The repository has no commit yet: commit once before starting a task.');
    let baseRef = o.baseRef?.trim();
    if (!baseRef) {
      const current = await git(o.gitPath, o.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      baseRef = current.code === 0 && current.out.trim() ? current.out.trim() : 'HEAD';
    }
    const baseCommit = (await gitOk(o.gitPath, o.repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
    let branch = o.branch;
    for (let i = 2; await branchExists(o.gitPath, o.repoRoot, branch); i++) branch = `${o.branch}-${i}`;
    await mkdir(dirname(o.path), { recursive: true });
    // Worktrees live under the user data folder: long paths must work on Windows.
    const longPaths = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
    await gitOk(o.gitPath, o.repoRoot, [...longPaths, 'worktree', 'add', '-b', branch, o.path, baseCommit], 300_000);
    return { branch, baseRef, baseCommit };
  });
}

/** Removes a worktree (retried: Windows keeps files locked for a moment after processes exit). */
export function removeWorktree(o: { gitPath: string; repoRoot: string; path: string; force: boolean }): Promise<void> {
  return serialized(o.repoRoot, async () => {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await git(o.gitPath, o.repoRoot, ['worktree', 'remove', ...(o.force ? ['--force'] : []), o.path]);
      if (r.code === 0) return;
      last = (r.err || r.out).trim();
      if (/is not a working tree|not a working tree/i.test(last)) {
        await rm(o.path, { recursive: true, force: true }).catch(() => undefined);
        await git(o.gitPath, o.repoRoot, ['worktree', 'prune']);
        return;
      }
      if (!o.force) break;
      await new Promise((r2) => setTimeout(r2, 500 * (attempt + 1)));
    }
    throw new OxyError('UNAVAILABLE', `The worktree could not be removed: ${last.slice(0, 500)}`);
  });
}

/** Copies untracked local files (".env") of the main checkout into the worktree; only paths inside the repository. */
export async function copyLocalFiles(o: { from: string; to: string; files: string[] }): Promise<string[]> {
  const copied: string[] = [];
  for (const file of o.files) {
    const source = resolve(o.from, file);
    const rel = relative(o.from, source);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) continue;
    const target = join(o.to, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    copied.push(rel.split(sep).join('/'));
  }
  return copied;
}

/** Commits everything in the worktree (a checkpoint); null when nothing changed. */
export function commitAll(o: {
  gitPath: string;
  cwd: string;
  message: string;
}): Promise<{ commit: string | null; files: number }> {
  return serialized(o.cwd, async () => {
    await gitOk(o.gitPath, o.cwd, ['add', '-A']);
    const staged = await git(o.gitPath, o.cwd, ['diff', '--cached', '--name-only']);
    const files = staged.out.split('\n').filter((l) => l.trim()).length;
    if (files === 0) return { commit: null, files: 0 };
    const identity = await identityArgs(o.gitPath, o.cwd);
    await gitOk(o.gitPath, o.cwd, [...identity, 'commit', '--no-verify', '-q', '-m', o.message]);
    const commit = (await gitOk(o.gitPath, o.cwd, ['rev-parse', 'HEAD'])).trim();
    return { commit, files };
  });
}

function parseNameStatus(out: string): Map<string, { status: EnsembleChange['status']; oldPath?: string }> {
  const map = new Map<string, { status: EnsembleChange['status']; oldPath?: string }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i] ?? '';
      const path = parts[++i] ?? '';
      map.set(path, { status: letter === 'R' ? 'renamed' : 'added', oldPath });
    } else {
      const path = parts[++i] ?? '';
      map.set(path, { status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified' });
    }
  }
  return map;
}

/**
 * Files changed from `base` to `head` (a commit), or to the working tree when `head` is not given (untracked files
 * included).
 */
export async function changes(o: {
  gitPath: string;
  cwd: string;
  base: string;
  head?: string | undefined;
}): Promise<EnsembleChange[]> {
  const range = o.head ? [o.base, o.head] : [o.base];
  const [names, nums] = await Promise.all([
    gitOk(o.gitPath, o.cwd, ['diff', '-z', '--name-status', '-M', ...range]),
    gitOk(o.gitPath, o.cwd, ['diff', '-z', '--numstat', '-M', ...range]),
  ]);
  const byPath = parseNameStatus(names);
  const counts = new Map<string, { additions?: number; deletions?: number; binary?: boolean }>();
  const parts = nums.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    const [add, del, path] = line.split('\t');
    let file = path ?? '';
    if (file === '') {
      i++;
      file = parts[++i] ?? '';
    }
    counts.set(file, add === '-' ? { binary: true } : { additions: Number(add), deletions: Number(del) });
  }
  const out: EnsembleChange[] = [...byPath].map(([path, v]) => ({ path, ...v, ...counts.get(path) }));
  if (!o.head) {
    const untracked = await gitOk(o.gitPath, o.cwd, ['ls-files', '-z', '--others', '--exclude-standard']);
    for (const path of untracked.split('\0').filter(Boolean))
      if (!byPath.has(path)) out.push({ path, status: 'untracked' });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A file's text at a commit (null: missing, binary or larger than `maxBytes`). */
export async function fileAt(o: {
  gitPath: string;
  cwd: string;
  ref: string;
  path: string;
  maxBytes: number;
}): Promise<string | null> {
  const spec = `${o.ref}:${o.path}`;
  const size = await git(o.gitPath, o.cwd, ['cat-file', '-s', spec]);
  if (size.code !== 0 || Number(size.out.trim()) > o.maxBytes) return null;
  const r = await runGit(o.gitPath, ['cat-file', '--filters', spec], { cwd: o.cwd, timeoutMs: 20_000 });
  if (r.code !== 0 || r.stdout.subarray(0, 8192).includes(0)) return null;
  const text = r.stdout.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface FinishRequest {
  gitPath: string;
  action: FinishAction;
  /** The repository's main checkout. */
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  /** Squash: the commit message. */
  message: string;
  /** Keep / discard: remove the worktree folder (keep keeps the branch). */
  removeWorktree: boolean;
}

/**
 * Finishes a task's branch. Merge and squash need the main checkout clean and on the base branch (they never touch
 * other work); keep removes only the worktree; discard removes the worktree and the branch.
 */
export async function finish(o: FinishRequest): Promise<{ detail: string }> {
  // Uncommitted work in the worktree is committed first, so nothing the agents did is lost.
  if ((await stat(o.worktreePath).catch(() => null))?.isDirectory() && o.action !== 'discard')
    await commitAll({ gitPath: o.gitPath, cwd: o.worktreePath, message: 'ensemble: last changes' }).catch(
      () => undefined,
    );
  if (o.action === 'merge' || o.action === 'squash') {
    const info = await repoInfo(o.gitPath, o.repoRoot);
    if (info.branch !== o.baseRef)
      throw new OxyError(
        'INVALID',
        `Your checkout is on ${info.branch ?? 'a detached HEAD'}, not ${o.baseRef}. Switch to ${o.baseRef} or keep the branch and merge it yourself.`,
      );
    if (info.dirty > 0)
      throw new OxyError(
        'INVALID',
        `Your checkout has ${info.dirty} uncommitted change${info.dirty === 1 ? '' : 's'}. Commit or stash them first, or keep the branch.`,
      );
    await serialized(o.repoRoot, async () => {
      if (o.action === 'merge') {
        const identity = await identityArgs(o.gitPath, o.repoRoot);
        const r = await git(o.gitPath, o.repoRoot, [...identity, 'merge', '--no-ff', '--no-edit', o.branch], 300_000);
        if (r.code !== 0) {
          await git(o.gitPath, o.repoRoot, ['merge', '--abort']);
          throw new OxyError(
            'UNAVAILABLE',
            `The merge stopped (conflicts?): ${(r.err || r.out).trim().slice(0, 600)}. Nothing was changed; keep the branch and merge it yourself.`,
          );
        }
      } else {
        const r = await git(o.gitPath, o.repoRoot, ['merge', '--squash', o.branch], 300_000);
        if (r.code !== 0) {
          await git(o.gitPath, o.repoRoot, ['reset', '--merge']);
          throw new OxyError(
            'UNAVAILABLE',
            `The squash stopped (conflicts?): ${(r.err || r.out).trim().slice(0, 600)}. Nothing was changed.`,
          );
        }
        const identity = await identityArgs(o.gitPath, o.repoRoot);
        const staged = await git(o.gitPath, o.repoRoot, ['diff', '--cached', '--name-only']);
        if (staged.out.trim())
          await gitOk(o.gitPath, o.repoRoot, [...identity, 'commit', '--no-verify', '-q', '-m', o.message]);
      }
    });
    await removeWorktree({ gitPath: o.gitPath, repoRoot: o.repoRoot, path: o.worktreePath, force: true }).catch(
      () => undefined,
    );
    // The branch is in the base now (squash: its changes are); a merged branch is deleted safely with -d.
    await serialized(o.repoRoot, () =>
      git(o.gitPath, o.repoRoot, ['branch', o.action === 'squash' ? '-D' : '-d', o.branch]),
    ).catch(() => undefined);
    return {
      detail:
        o.action === 'merge' ? `${o.branch} merged into ${o.baseRef}` : `squashed into one commit on ${o.baseRef}`,
    };
  }
  if (o.removeWorktree)
    await removeWorktree({ gitPath: o.gitPath, repoRoot: o.repoRoot, path: o.worktreePath, force: true });
  if (o.action === 'discard') {
    await serialized(o.repoRoot, () => gitOk(o.gitPath, o.repoRoot, ['branch', '-D', o.branch]));
    return { detail: `${o.branch} deleted` };
  }
  return { detail: `branch ${o.branch} kept` };
}

/** Rewinds the worktree to a checkpoint (discarding everything after it). */
export function resetTo(o: { gitPath: string; cwd: string; commit: string }): Promise<void> {
  return serialized(o.cwd, async () => {
    await gitOk(o.gitPath, o.cwd, ['reset', '--hard', o.commit]);
    await gitOk(o.gitPath, o.cwd, ['clean', '-fd']);
  });
}
