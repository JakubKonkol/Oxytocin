import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

export interface ProjectRef {
  id: string;
  rootPath: string;
}

/** `cwd` → Oxytocin project by the longest matching root (docs/plan/08-usage-monitor.md §6). */
export class ProjectAttribution {
  private projects: ProjectRef[] = [];
  private readonly cache = new Map<string, string | null>();
  private hashes = new Map<string, string>();

  constructor(private readonly caseInsensitive = process.platform === 'win32' || process.platform === 'darwin') {}

  /** Replaces the project list; returns true when attributions may change. */
  setProjects(projects: ProjectRef[]): boolean {
    const next = [...projects].sort((a, b) => b.rootPath.length - a.rootPath.length);
    if (JSON.stringify(next) === JSON.stringify(this.projects)) return false;
    this.projects = next;
    this.cache.clear();
    this.hashes = new Map();
    for (const p of next) for (const h of projectHashes(p.rootPath)) if (!this.hashes.has(h)) this.hashes.set(h, p.id);
    return true;
  }

  /** Gemini CLI sessions: sha256 of the project root. */
  projectForHash(hash: string | undefined | null): string | null {
    return hash ? (this.hashes.get(hash) ?? null) : null;
  }

  projectFor(cwd: string | undefined | null): string | null {
    if (!cwd) return null;
    const cached = this.cache.get(cwd);
    if (cached !== undefined) return cached;
    const norm = (p: string) => (this.caseInsensitive ? resolve(p).toLowerCase() : resolve(p));
    const target = norm(cwd);
    let found: string | null = null;
    for (const p of this.projects) {
      const rel = relative(norm(p.rootPath), target);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        found = p.id;
        break;
      }
    }
    this.cache.set(cwd, found);
    return found;
  }
}

/**
 * Hashes Gemini CLI may have used for a project root (`sha256(projectRoot)` of the path string, S7): as stored,
 * without a trailing separator, and with either case of a Windows drive letter.
 */
export function projectHashes(rootPath: string): string[] {
  const variants = new Set<string>();
  const trimmed = rootPath.length > 1 ? rootPath.replace(/[\\/]+$/, '') : rootPath;
  for (const p of [rootPath, trimmed]) {
    variants.add(p);
    if (/^[a-zA-Z]:/.test(p)) {
      variants.add(p[0]!.toLowerCase() + p.slice(1));
      variants.add(p[0]!.toUpperCase() + p.slice(1));
    }
  }
  return [...variants].map((v) => createHash('sha256').update(v).digest('hex'));
}
