import type { ChangeStatus, FileChange } from '@shared/domain/git';

export interface DirNode {
  kind: 'dir';
  /** Full project-relative path of the (last) folder in a compacted chain — the expansion key. */
  path: string;
  /** Display name; compacted chains read `src/features/terminals`. */
  name: string;
  children: TreeNode[];
  fileCount: number;
  /** Most severe status in the subtree. */
  status: ChangeStatus;
  /** Latest touch in the subtree. */
  touchedAt?: number;
}

export interface FileNode {
  kind: 'file';
  path: string;
  name: string;
  /** Parent folder (list mode). */
  dir: string;
  file: FileChange;
}

export type TreeNode = DirNode | FileNode;

export interface Row {
  node: TreeNode;
  depth: number;
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

export const STATUS_LETTERS: Record<ChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
  typechange: 'T',
};

export const STATUS_LABELS: Record<ChangeStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  conflicted: 'Conflicted',
  typechange: 'Type changed',
};

const compareNames = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}

interface MutableDir {
  path: string;
  name: string;
  dirs: Map<string, MutableDir>;
  files: FileNode[];
}

/** Folder tree with compacted single-child folder chains; folders first, then files, alphabetically. */
export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const root: MutableDir = { path: '', name: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = { path: parts.slice(0, i + 1).join('/'), name, dirs: new Map(), files: [] };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    const { dir: parent, name } = splitPath(file.path);
    dir.files.push({ kind: 'file', path: file.path, name, dir: parent, file });
  }

  const finish = (dir: MutableDir): DirNode => {
    // Compact chains of folders that only contain one folder.
    let current = dir;
    let name = dir.name;
    while (current.files.length === 0 && current.dirs.size === 1) {
      const only = current.dirs.values().next().value!;
      name = `${name}/${only.name}`;
      current = only;
    }
    const children = childrenOf(current);
    let fileCount = 0;
    let status: ChangeStatus = 'added';
    let touchedAt: number | undefined;
    for (const child of children) {
      const s = child.kind === 'dir' ? child.status : child.file.status;
      if (SEVERITY[s] > SEVERITY[status]) status = s;
      fileCount += child.kind === 'dir' ? child.fileCount : 1;
      const t = child.kind === 'dir' ? child.touchedAt : child.file.touchedAt;
      if (t !== undefined && (touchedAt === undefined || t > touchedAt)) touchedAt = t;
    }
    return {
      kind: 'dir',
      path: current.path,
      name,
      children,
      fileCount,
      status,
      ...(touchedAt !== undefined ? { touchedAt } : {}),
    };
  };

  const childrenOf = (dir: MutableDir): TreeNode[] => [
    ...[...dir.dirs.values()].sort((a, b) => compareNames(a.name, b.name)).map(finish),
    ...[...dir.files].sort((a, b) => compareNames(a.name, b.name)),
  ];

  return childrenOf(root);
}

/** All folder keys of a tree (expand all). */
export function allDirPaths(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'dir') {
      out.push(n.path);
      allDirPaths(n.children, out);
    }
  }
  return out;
}

const matches = (file: FileChange, filter: string) => file.path.toLowerCase().includes(filter);

/**
 * Visible rows: folders show their children when expanded (`expanded === null` → everything expanded);
 * a filter keeps matching files and their folders, all expanded.
 */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string> | null, filter = ''): Row[] {
  const needle = filter.trim().toLowerCase();
  const rows: Row[] = [];
  const visit = (list: readonly TreeNode[], depth: number): boolean => {
    let any = false;
    for (const node of list) {
      if (node.kind === 'file') {
        if (needle && !matches(node.file, needle)) continue;
        rows.push({ node, depth });
        any = true;
        continue;
      }
      const at = rows.length;
      rows.push({ node, depth });
      const open = needle !== '' || expanded === null || expanded.has(node.path);
      if (open) {
        const hasChildren = visit(node.children, depth + 1);
        if (needle && !hasChildren) {
          rows.splice(at, 1);
          continue;
        }
      } else if (needle) {
        rows.splice(at, 1);
        continue;
      }
      any = true;
    }
    return any;
  };
  visit(nodes, 0);
  return rows;
}

/** List mode: files sorted by path, each with its folder. */
export function flattenList(files: readonly FileChange[], filter = ''): Row[] {
  const needle = filter.trim().toLowerCase();
  return files
    .filter((f) => !needle || matches(f, needle))
    .map((file) => {
      const { dir, name } = splitPath(file.path);
      return { node: { kind: 'file' as const, path: file.path, name, dir, file }, depth: 0 };
    })
    .sort((a, b) => compareNames(a.node.path, b.node.path));
}

/** Parent folder key of a row path within the rows (← on a file jumps to its folder). */
export function parentRowIndex(rows: readonly Row[], index: number): number {
  const row = rows[index];
  if (!row) return -1;
  for (let i = index - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) return i;
  return -1;
}
