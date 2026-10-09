import type { BranchInfo, BranchList, FileChange, GitAction, GitActionResult } from '@shared/domain/git';
import { OxyError } from '@shared/errors';
import { runGit } from './exec';
import { serialized } from './serialize';

/**
 * Git actions of the CHANGES section: staging, discarding, committing, syncing, stashing and switching branches.
 * Paths are project-relative; they reach git as literal pathspecs (no globbing), relative to the toplevel.
 */
export interface GitActionInput {
  gitPath: string;
  toplevel: string;
  /** Project folder relative to the toplevel, or null when the project is the toplevel. */
  pathspec: string | null;
  hasHead: boolean;
  /** The latest status: what kind of change each path is (discard depends on it). */
  files: readonly FileChange[];
  branch?: BranchInfo | undefined;
}

const ENV = {
  // Paths are file names, never patterns: `a[1].ts` must not match `a1.ts`.
  GIT_LITERAL_PATHSPECS: '1',
  // Nothing may wait for an editor (merge messages of a pull, commit templates).
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

/** Paths per git call: keeps command lines far below the Windows limit (32k characters). */
const CHUNK = 100;

const NETWORK_TIMEOUT_MS = 180_000;

interface Run {
  code: number;
  out: string;
  err: string;
}

/** `git stash --include-untracked` misses untracked files with literal pathspecs (git 2.43). */
const NO_LITERAL = new Set(['stash']);

async function git(input: GitActionInput, args: string[], timeoutMs = 60_000): Promise<Run> {
  const env = NO_LITERAL.has(args[0] ?? '') ? { ...ENV, GIT_LITERAL_PATHSPECS: '0' } : ENV;
  const r = await runGit(input.gitPath, args, { cwd: input.toplevel, timeoutMs, env });
  return { code: r.code, out: r.stdout.toString('utf8'), err: r.stderr };
}

/** Git's own message (the last lines of stderr, or stdout), without hints. */
export function gitMessage(r: Pick<Run, 'out' | 'err'>): string {
  const text = (r.err.trim() || r.out.trim())
    .split('\n')
    .filter((l) => !l.startsWith('hint:'))
    .join('\n')
    .trim();
  return text.length > 1500 ? `…${text.slice(-1500)}` : text;
}

async function gitOk(input: GitActionInput, args: string[], timeoutMs?: number): Promise<Run> {
  const r = await git(input, args, timeoutMs);
  if (r.code !== 0) throw new OxyError('UNAVAILABLE', gitMessage(r) || `git ${args[0]} failed (exit code ${r.code})`);
  return r;
}

/** Runs `args -- <paths>` in chunks. */
async function withPaths(input: GitActionInput, args: string[], paths: readonly string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += CHUNK) await gitOk(input, [...args, '--', ...paths.slice(i, i + CHUNK)]);
}

const toTop = (input: GitActionInput, path: string) => (input.pathspec ? `${input.pathspec}/${path}` : path);
/** The whole project as a pathspec. */
const projectSpec = (input: GitActionInput) => input.pathspec ?? '.';

/** Rejects paths that leave the project (`..`, absolute paths). */
export function checkPaths(paths: readonly string[]): void {
  for (const p of paths) {
    const parts = p.split('/');
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\\') || parts.includes('..') || parts.includes(''))
      throw new OxyError('INVALID', `Invalid path: ${p}`);
  }
}

/** The paths of `paths` with the original path of renames (staging a rename needs both sides). */
function withRenameSources(input: GitActionInput, paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(toTop(input, p));
    const old = input.files.find((f) => f.path === p)?.oldPath;
    if (old) out.add(toTop(input, old));
  }
  return [...out];
}

async function unstage(input: GitActionInput, topPaths: readonly string[]): Promise<void> {
  if (input.hasHead) await withPaths(input, ['reset', '-q', 'HEAD'], topPaths);
  else await withPaths(input, ['rm', '--cached', '-r', '-q', '--ignore-unmatch'], topPaths);
}

/** Back to HEAD, by kind of change: new files are deleted, tracked ones restored (index and working tree). */
async function discard(input: GitActionInput, paths: readonly string[]): Promise<void> {
  const untracked: string[] = [];
  const added: string[] = [];
  const tracked: string[] = [];
  for (const p of paths) {
    const f = input.files.find((x) => x.path === p);
    const status = f?.status ?? 'modified';
    if (status === 'untracked') untracked.push(toTop(input, p));
    else if (status === 'added' || !input.hasHead) added.push(toTop(input, p));
    else if (status === 'renamed') {
      added.push(toTop(input, p));
      if (f?.oldPath) tracked.push(toTop(input, f.oldPath));
    } else tracked.push(toTop(input, p));
  }
  if (untracked.length) await withPaths(input, ['clean', '-f', '-q'], untracked);
  if (added.length) await withPaths(input, ['rm', '-f', '-q', '--ignore-unmatch'], added);
  if (tracked.length) await withPaths(input, ['checkout', '-q', 'HEAD'], tracked);
}

async function discardAll(input: GitActionInput): Promise<void> {
  const spec = projectSpec(input);
  if (input.hasHead) {
    await gitOk(input, ['reset', '-q', 'HEAD', '--', spec]);
    await gitOk(input, ['checkout', '-q', 'HEAD', '--', spec]);
  } else {
    await gitOk(input, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', spec]);
  }
  await gitOk(input, ['clean', '-f', '-d', '-q', '--', spec]);
}

async function checkBranchName(input: GitActionInput, name: string): Promise<void> {
  const r = await git(input, ['check-ref-format', '--branch', name]);
  if (r.code !== 0) throw new OxyError('INVALID', `"${name}" is not a valid branch name.`);
}

/** The remote a branch without upstream is pushed to: `origin`, else the only/first remote. */
async function pushRemote(input: GitActionInput): Promise<string> {
  const remotes = (await gitOk(input, ['remote'])).out.split('\n').filter(Boolean);
  if (remotes.length === 0) throw new OxyError('UNAVAILABLE', 'The repository has no remote to push to.');
  return remotes.includes('origin') ? 'origin' : remotes[0]!;
}

const summary = (r: Run) => gitMessage(r);

export function runGitAction(input: GitActionInput, action: GitAction): Promise<GitActionResult> {
  if ('paths' in action) checkPaths(action.paths);
  return serialized(input.toplevel, async (): Promise<GitActionResult> => {
    switch (action.kind) {
      case 'stage':
        await withPaths(input, ['add', '-A'], withRenameSources(input, action.paths));
        return { output: '' };
      case 'unstage':
        await unstage(input, withRenameSources(input, action.paths));
        return { output: '' };
      case 'stageAll':
        await gitOk(input, ['add', '-A', '--', projectSpec(input)]);
        return { output: '' };
      case 'unstageAll':
        await unstage(input, [projectSpec(input)]);
        return { output: '' };
      case 'discard':
        await discard(input, action.paths);
        return { output: '' };
      case 'discardAll':
        await discardAll(input);
        return { output: '' };
      case 'commit': {
        const message = action.message.trim();
        if (!message && !action.amend) throw new OxyError('INVALID', 'Enter a commit message.');
        if (action.stageAll) await gitOk(input, ['add', '-A', '--', projectSpec(input)]);
        const args = ['commit', '-q'];
        if (action.amend) args.push('--amend');
        if (message) args.push('-m', message);
        else args.push('--no-edit');
        // Commit hooks (lint-staged…) may take a while.
        await gitOk(input, args, 300_000);
        const head = await gitOk(input, ['rev-parse', 'HEAD']);
        return { output: '', commit: head.out.trim() };
      }
      case 'undoCommit': {
        const parent = await git(input, ['rev-parse', '--verify', '-q', 'HEAD~1']);
        if (parent.code !== 0) throw new OxyError('UNAVAILABLE', 'There is no earlier commit to go back to.');
        await gitOk(input, ['reset', '--soft', '-q', 'HEAD~1']);
        return { output: '' };
      }
      case 'push': {
        if (input.branch?.detached) throw new OxyError('UNAVAILABLE', 'HEAD is detached: switch to a branch first.');
        const args = input.branch?.upstream ? ['push'] : ['push', '-u', await pushRemote(input), 'HEAD'];
        return { output: summary(await gitOk(input, args, NETWORK_TIMEOUT_MS)) };
      }
      case 'pull':
        if (!input.branch?.upstream)
          throw new OxyError('UNAVAILABLE', 'The branch has no upstream: push it first, or pull in a terminal.');
        return { output: summary(await gitOk(input, ['pull'], NETWORK_TIMEOUT_MS)) };
      case 'fetch':
        return { output: summary(await gitOk(input, ['fetch', '--prune'], NETWORK_TIMEOUT_MS)) };
      case 'stash': {
        const args = ['stash', 'push', '--include-untracked'];
        if (action.message?.trim()) args.push('-m', action.message.trim());
        if (input.pathspec) args.push('--', input.pathspec);
        return { output: summary(await gitOk(input, args)) };
      }
      case 'stashPop':
        return { output: summary(await gitOk(input, ['stash', 'pop'])) };
      case 'checkout':
        await checkBranchName(input, action.branch);
        return { output: summary(await gitOk(input, ['switch', action.branch])) };
      case 'createBranch':
        await checkBranchName(input, action.name);
        return { output: summary(await gitOk(input, ['switch', '-c', action.name])) };
    }
  });
}

/** Local branches (most recent first), remotes and the number of stashes. */
export async function listBranches(input: Pick<GitActionInput, 'gitPath' | 'toplevel'>): Promise<BranchList> {
  const run = (args: string[]) =>
    runGit(input.gitPath, args, { cwd: input.toplevel, timeoutMs: 15_000 }).then((r) => ({
      code: r.code,
      out: r.stdout.toString('utf8'),
    }));
  const [heads, current, remotes, stashes] = await Promise.all([
    run([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%00%(upstream:short)%00%(committerdate:unix)',
      'refs/heads',
    ]),
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    run(['remote']),
    run(['stash', 'list', '--format=%H']),
  ]);
  return {
    current: current.code === 0 ? current.out.trim() || null : null,
    local: heads.out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', upstream = '', date = '0'] = line.split('\0');
        return { name, ...(upstream ? { upstream } : {}), date: Number(date) * 1000 };
      }),
    remotes: remotes.out.split('\n').filter(Boolean),
    stashes: stashes.code === 0 ? stashes.out.split('\n').filter(Boolean).length : 0,
  };
}
