import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileChange, RepoStatus } from '@shared/domain/git';
import { runGit } from './exec';
import { type NumstatEntry, parseNumstat, parsePorcelainV2, statusVsHead } from './porcelain-v2';

/** `git hash-object -t tree /dev/null` — diff base for repositories without commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const MAX_COUNTED_UNTRACKED = 2000;
const MAX_COUNTED_SIZE = 1024 * 1024;

export interface ComputeStatusInput {
  projectId: string;
  gitPath: string;
  toplevel: string;
  /** Project folder relative to the toplevel ('/' separators) or null when the project is the toplevel. */
  pathspec: string | null;
  hasHead: boolean;
  maxFiles: number;
  /** Project-relative path → last file-system event. */
  touched?: ReadonlyMap<string, number>;
  /** Previous head commit, reused while the HEAD oid is unchanged. */
  previousHeadCommit?: RepoStatus['headCommit'];
  now?: () => number;
}

/** Lines of an untracked text file (null for binaries or files too large to count). */
export async function countLines(path: string): Promise<{ lines: number; binary: boolean } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const handle = await open(path, 'r');
    try {
      const head = Buffer.alloc(Math.min(8192, info.size));
      await handle.read(head, 0, head.length, 0);
      if (head.includes(0)) return { lines: 0, binary: true };
      if (info.size > MAX_COUNTED_SIZE) return null;
      const buf = Buffer.alloc(info.size);
      await handle.read(buf, 0, info.size, 0);
      if (buf.length === 0) return { lines: 0, binary: false };
      let lines = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
      if (buf[buf.length - 1] !== 10) lines++;
      return { lines, binary: false };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Toplevel-relative → project-relative; null when outside the project. */
function toProjectPath(path: string, pathspec: string | null): string | null {
  if (!pathspec) return path;
  const prefix = `${pathspec}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/**
 * Changes of the working tree + index relative to HEAD (docs/plan/06-git-changes.md §4): porcelain v2 status,
 * numstat line counts and counted lines of untracked files.
 */
export async function computeStatus(input: ComputeStatusInput): Promise<RepoStatus> {
  const now = input.now ?? Date.now;
  const started = now();
  const spec = input.pathspec ? ['--', input.pathspec] : [];
  const base = {
    projectId: input.projectId,
    toplevel: input.toplevel,
    hasHead: input.hasHead,
  };
  const [status, numstat] = await Promise.all([
    runGit(
      input.gitPath,
      ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames', ...spec],
      { cwd: input.toplevel, timeoutMs: 30_000 },
    ),
    runGit(input.gitPath, ['diff', input.hasHead ? 'HEAD' : EMPTY_TREE, '--numstat', '-z', '--find-renames', ...spec], {
      cwd: input.toplevel,
      timeoutMs: 30_000,
    }),
  ]);
  if (status.code !== 0) {
    return {
      ...base,
      state: 'error',
      error: status.stderr.trim() || `git status exited with code ${status.code}`,
      files: [],
      totals: { files: 0, additions: 0, deletions: 0 },
      computedAt: now(),
      durationMs: now() - started,
    };
  }
  const parsed = parsePorcelainV2(status.stdout.toString('utf8'));
  const counts = new Map<string, NumstatEntry>();
  if (numstat.code === 0) for (const e of parseNumstat(numstat.stdout.toString('utf8'))) counts.set(e.path, e);

  const files: FileChange[] = [];
  let untrackedCounted = 0;
  for (const rec of parsed.records) {
    const change = statusVsHead(rec);
    if (!change) continue;
    const path = toProjectPath(rec.path, input.pathspec);
    if (path === null) continue;
    const file: FileChange = {
      path,
      status: change,
      staged: rec.type !== '?' && rec.type !== '!' && rec.xy[0] !== '.',
      unstaged: rec.type === '?' || (rec.type !== '!' && rec.xy[1] !== '.'),
    };
    if (rec.type === '2') {
      const old = toProjectPath(rec.origPath, input.pathspec);
      file.oldPath = old ?? rec.origPath;
    }
    if ((rec.type === '1' || rec.type === '2') && rec.sub.startsWith('S')) file.submodule = true;
    const touchedAt = input.touched?.get(path);
    if (touchedAt !== undefined) file.touchedAt = touchedAt;
    if (rec.type === '?') {
      if (untrackedCounted < MAX_COUNTED_UNTRACKED) {
        untrackedCounted++;
        const counted = await countLines(join(input.toplevel, rec.path));
        if (counted?.binary) file.binary = true;
        else if (counted) {
          file.additions = counted.lines;
          file.deletions = 0;
        }
      }
    } else {
      const n = counts.get(rec.path);
      if (n) {
        if (n.binary) file.binary = true;
        if (n.additions !== null) file.additions = n.additions;
        if (n.deletions !== null) file.deletions = n.deletions;
      }
    }
    files.push(file);
  }

  const totals = { files: files.length, additions: 0, deletions: 0 };
  for (const f of files) {
    totals.additions += f.additions ?? 0;
    totals.deletions += f.deletions ?? 0;
  }
  let shown = files;
  if (files.length > input.maxFiles) {
    // Most recently touched first, so what the agent is writing right now stays visible.
    shown = [...files].sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0)).slice(0, input.maxFiles);
  }
  shown.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let headCommit = input.previousHeadCommit;
  const oid = parsed.branch.oid;
  if (!oid) headCommit = undefined;
  else if (headCommit?.oid !== oid) {
    const log = await runGit(input.gitPath, ['log', '-1', '--format=%H%x00%s%x00%ct', oid], {
      cwd: input.toplevel,
      timeoutMs: 10_000,
    }).catch(() => null);
    const [hash, subject, date] = log?.code === 0 ? log.stdout.toString('utf8').trim().split('\0') : [];
    headCommit = hash ? { oid: hash, subject: subject ?? '', date: Number(date ?? 0) * 1000 } : undefined;
  }

  return {
    ...base,
    hasHead: !!oid,
    state: 'ok',
    branch: parsed.branch,
    ...(headCommit ? { headCommit } : {}),
    files: shown,
    totals,
    ...(shown.length < files.length ? { truncated: { shown: shown.length, total: files.length } } : {}),
    computedAt: now(),
    durationMs: now() - started,
  };
}
