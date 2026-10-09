import type { ChangeStatus } from '@shared/domain/git';
import type { DirState } from './files-store';

export interface FileRow {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  depth: number;
  ignored: boolean;
  symlink: boolean;
  /** An expanded folder still loading, or one that could not be read. */
  note?: string;
}

/** Visible rows of the file tree: expanded folders contribute their (loaded) entries, depth first. */
export function flattenFiles(dirs: Readonly<Record<string, DirState>>, expanded: ReadonlySet<string>): FileRow[] {
  const rows: FileRow[] = [];
  const walk = (dir: string, depth: number) => {
    const state = dirs[dir];
    if (!state) return;
    if ('error' in state) return;
    for (const e of state.entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      rows.push({ path, name: e.name, kind: e.kind, depth, ignored: !!e.ignored, symlink: !!e.symlink });
      if (e.kind === 'dir' && expanded.has(path)) {
        const child = dirs[path];
        if (!child)
          rows.push({
            path: `${path}/…`,
            name: 'Loading…',
            kind: 'file',
            depth: depth + 1,
            ignored: true,
            symlink: false,
            note: 'loading',
          });
        else if ('error' in child)
          rows.push({
            path: `${path}/!`,
            name: child.error,
            kind: 'file',
            depth: depth + 1,
            ignored: true,
            symlink: false,
            note: 'error',
          });
        else walk(path, depth + 1);
      }
    }
  };
  walk('', 0);
  return rows;
}

const SEVERITY: Record<ChangeStatus, number> = {
  conflicted: 5,
  deleted: 4,
  modified: 3,
  typechange: 3,
  renamed: 3,
  added: 2,
  untracked: 2,
};

/** Git status per path, plus the most severe status of each folder that contains changes. */
export function statusIndex(files: readonly { path: string; status: ChangeStatus }[]): Map<string, ChangeStatus> {
  const map = new Map<string, ChangeStatus>();
  for (const f of files) {
    map.set(f.path, f.status);
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const current = map.get(dir);
      if (!current || SEVERITY[f.status] > SEVERITY[current]) map.set(dir, f.status);
    }
  }
  return map;
}
