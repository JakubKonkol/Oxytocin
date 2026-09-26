import { isAbsolute, relative, resolve } from 'node:path';

export interface ProjectRef {
  id: string;
  rootPath: string;
}

/** `cwd` → Oxytocin project by the longest matching root (docs/plan/08-usage-monitor.md §6). */
export class ProjectAttribution {
  private projects: ProjectRef[] = [];
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly caseInsensitive = process.platform === 'win32' || process.platform === 'darwin') {}

  /** Replaces the project list; returns true when attributions may change. */
  setProjects(projects: ProjectRef[]): boolean {
    const next = [...projects].sort((a, b) => b.rootPath.length - a.rootPath.length);
    if (JSON.stringify(next) === JSON.stringify(this.projects)) return false;
    this.projects = next;
    this.cache.clear();
    return true;
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
