import type { BranchInfo, ChangeStatus } from '@shared/domain/git';

export type PorcelainRecord =
  | { type: '1'; xy: string; sub: string; path: string }
  | { type: '2'; xy: string; sub: string; path: string; origPath: string; score: string }
  | { type: 'u'; xy: string; sub: string; path: string }
  | { type: '?'; path: string }
  | { type: '!'; path: string };

export interface PorcelainStatus {
  branch: BranchInfo;
  records: PorcelainRecord[];
}

/** Splits a line into `count` space-separated fields; the last keeps the rest (paths may contain spaces). */
function fields(line: string, count: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < count - 1; i++) {
    const idx = rest.indexOf(' ');
    if (idx < 0) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  out.push(rest);
  return out;
}

/** Parses `git status --porcelain=v2 -z --branch` (docs/plan/06-git-changes.md §4.2). */
export function parsePorcelainV2(output: string): PorcelainStatus {
  const branch: BranchInfo = { head: null, detached: false, ahead: 0, behind: 0 };
  const records: PorcelainRecord[] = [];
  const parts = output.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    if (entry.startsWith('# ')) {
      const [key, ...rest] = entry.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid' && value !== '(initial)') branch.oid = value;
      else if (key === 'branch.head') {
        if (value === '(detached)') branch.detached = true;
        else branch.head = value;
      } else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    switch (entry[0]) {
      case '1': {
        const f = fields(entry, 9);
        records.push({ type: '1', xy: f[1]!, sub: f[2]!, path: f[8]! });
        break;
      }
      case '2': {
        const f = fields(entry, 10);
        // With -z the original path is the next NUL-separated field.
        const origPath = parts[++i] ?? '';
        records.push({ type: '2', xy: f[1]!, sub: f[2]!, score: f[8]!, path: f[9]!, origPath });
        break;
      }
      case 'u': {
        const f = fields(entry, 11);
        records.push({ type: 'u', xy: f[1]!, sub: f[2]!, path: f[10]! });
        break;
      }
      case '?':
        records.push({ type: '?', path: entry.slice(2) });
        break;
      case '!':
        records.push({ type: '!', path: entry.slice(2) });
        break;
      default:
        break;
    }
  }
  return { branch, records };
}

/** Status of a record relative to HEAD, staged and unstaged combined (docs/plan/06-git-changes.md §4.3). */
export function statusVsHead(rec: PorcelainRecord): ChangeStatus | null {
  if (rec.type === 'u') return 'conflicted';
  if (rec.type === '?') return 'untracked';
  if (rec.type === '!') return null;
  const X = rec.xy[0];
  const Y = rec.xy[1];
  if (X === 'A' && Y === 'D') return null;
  if (rec.type === '2') return 'renamed';
  if (X === 'A') return 'added';
  if (X === 'D' || Y === 'D') return 'deleted';
  if (X === 'T' || Y === 'T') return 'typechange';
  if (X === 'M' || Y === 'M' || X === 'R' || X === 'C') return 'modified';
  return null;
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Parses `git diff --numstat -z` (renames: `add\tdel\t\0old\0new\0`; binaries: `-\t-`). */
export function parseNumstat(output: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  const parts = output.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    const additions = m[1] === '-' ? null : Number(m[1]);
    const deletions = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      const oldPath = parts[++i] ?? '';
      const path = parts[++i] ?? '';
      out.push({ path, oldPath, additions, deletions, binary });
    } else {
      out.push({ path: m[3]!, additions, deletions, binary });
    }
  }
  return out;
}
