import { randomUUID } from 'node:crypto';
import {
  type AddProjectResult,
  colorForPath,
  type Project,
  type ProjectPatch,
  type ProjectsFile,
  ProjectsFileSchema,
} from '@shared/domain/project';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { JsonFileStore } from '../storage/json-file-store';
import { comparisonKey, isWithin, normalizeRoot, pathApi } from './path-utils';

export interface ProjectFs {
  /** Resolves symlinks/junctions and the on-disk letter case. */
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
}

export interface ProjectServiceDeps {
  file: string;
  fs: ProjectFs;
  platform: NodeJS.Platform;
  homeDir: string;
  /** %SystemRoot% on Windows. */
  systemRoot?: string;
  logger: Logger;
  now?: () => number;
  newId?: () => string;
}

const newProjectId = () => randomUUID().replace(/-/g, '').slice(0, 12);

/** Migrates older projects.json layouts (currently only version 1 exists). */
export function migrateProjectsFile(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !('version' in raw) && 'projects' in raw) {
    return { version: 1, activeProjectId: null, ...raw };
  }
  return raw;
}

/** Projects: userData/projects.json + runtime `missing` flags. */
export class ProjectService implements Disposable {
  private readonly store: JsonFileStore<ProjectsFile>;
  private readonly missing = new Set<string>();
  private readonly changeEmitter = new Emitter<Project[]>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly activeEmitter = new Emitter<string | null>();
  readonly onDidChangeActive = this.activeEmitter.event;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.store = new JsonFileStore({
      path: deps.file,
      schema: ProjectsFileSchema,
      defaults: () => ({ version: 1, projects: [], activeProjectId: null }),
      migrate: migrateProjectsFile,
      debounceMs: 300,
      backup: true,
      logger: deps.logger,
    });
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? newProjectId;
  }

  async load(): Promise<void> {
    await this.store.load();
    await this.refreshMissing();
  }

  /** Re-checks which project folders exist. */
  async refreshMissing(): Promise<void> {
    const before = [...this.missing].sort().join();
    this.missing.clear();
    await Promise.all(
      this.store.get().projects.map(async (p) => {
        if (!(await this.deps.fs.isDirectory(p.rootPath))) this.missing.add(p.id);
      }),
    );
    if ([...this.missing].sort().join() !== before) this.emit();
  }

  private withRuntime(p: ProjectsFile['projects'][number]): Project {
    return this.missing.has(p.id) ? { ...p, missing: true } : { ...p };
  }

  /** Pinned first, then by `order`. */
  list(): Project[] {
    return [...this.store.get().projects]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order)
      .map((p) => this.withRuntime(p));
  }

  get(id: string): Project | undefined {
    const p = this.store.get().projects.find((x) => x.id === id);
    return p ? this.withRuntime(p) : undefined;
  }

  get activeProjectId(): string | null {
    return this.store.get().activeProjectId;
  }

  private emit(): void {
    this.changeEmitter.fire(this.list());
  }

  private require(id: string): ProjectsFile['projects'][number] {
    const p = this.store.get().projects.find((x) => x.id === id);
    if (!p) throw new OxyError('NOT_FOUND', `Project ${id} not found`);
    return p;
  }

  /** Validates, canonicalizes and rejects whole drives / the home folder / the Windows folder. */
  private async canonicalRoot(input: string): Promise<string> {
    const { platform, fs } = this.deps;
    const p = pathApi(platform);
    const resolved = normalizeRoot(input, platform);
    if (!(await fs.isDirectory(resolved))) throw new OxyError('INVALID', `Not a folder: ${resolved}`);
    const real = normalizeRoot(await fs.realpath(resolved).catch(() => resolved), platform);
    const tooBroad = [
      p.parse(real).root,
      this.deps.homeDir,
      ...(this.deps.systemRoot ? [this.deps.systemRoot] : []),
    ].some((broad) => comparisonKey(real, platform) === comparisonKey(broad, platform));
    if (tooBroad) {
      throw new OxyError('INVALID', 'Choose a project folder, not a whole drive or your home folder');
    }
    return real;
  }

  findByPath(path: string): Project | undefined {
    // Longest matching root wins (nested projects).
    let best: ProjectsFile['projects'][number] | undefined;
    for (const p of this.store.get().projects) {
      if (isWithin(path, p.rootPath, this.deps.platform) && (!best || p.rootPath.length > best.rootPath.length))
        best = p;
    }
    return best ? this.withRuntime(best) : undefined;
  }

  async add(path: string): Promise<AddProjectResult> {
    const root = await this.canonicalRoot(path);
    const key = comparisonKey(root, this.deps.platform);
    const existing = this.store.get().projects.find((p) => comparisonKey(p.rootPath, this.deps.platform) === key);
    if (existing) {
      await this.setActive(existing.id);
      return { project: this.withRuntime(existing), existed: true };
    }
    const projects = this.store.get().projects;
    const parent = projects.find((p) => isWithin(root, p.rootPath, this.deps.platform));
    const child = projects.find((p) => isWithin(p.rootPath, root, this.deps.platform));
    const warning = parent
      ? `Project ‘${parent.name}’ contains this folder`
      : child
        ? `This folder contains the project ‘${child.name}’`
        : undefined;
    const project: ProjectsFile['projects'][number] = {
      id: this.newId(),
      name: pathApi(this.deps.platform).basename(root) || root,
      rootPath: root,
      color: colorForPath(key),
      pinned: false,
      order: projects.reduce((max, p) => Math.max(max, p.order), -1) + 1,
      createdAt: this.now(),
      settings: {},
    };
    this.store.update((s) => ({ ...s, projects: [...s.projects, project] }));
    this.missing.delete(project.id);
    this.deps.logger.info(`Added project ${project.name} (${root})`);
    this.emit();
    await this.setActive(project.id);
    return warning ? { project: { ...project }, existed: false, warning } : { project: { ...project }, existed: false };
  }

  async update(patch: ProjectPatch): Promise<Project> {
    const current = this.require(patch.id);
    const next = { ...current };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.icon === null) delete next.icon;
    else if (patch.icon !== undefined) next.icon = patch.icon;
    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    if (patch.settings !== undefined) next.settings = patch.settings;
    if (patch.rootPath !== undefined) {
      const root = await this.canonicalRoot(patch.rootPath);
      const clash = this.store
        .get()
        .projects.find(
          (p) =>
            p.id !== current.id &&
            comparisonKey(p.rootPath, this.deps.platform) === comparisonKey(root, this.deps.platform),
        );
      if (clash) throw new OxyError('INVALID', `‘${clash.name}’ already uses this folder`);
      next.rootPath = root;
      this.missing.delete(current.id);
    }
    this.store.update((s) => ({ ...s, projects: s.projects.map((p) => (p.id === next.id ? next : p)) }));
    this.emit();
    return this.withRuntime(next);
  }

  reorder(ids: readonly string[]): void {
    const rank = new Map(ids.map((id, i) => [id, i]));
    this.store.update((s) => ({
      ...s,
      projects: s.projects.map((p) => ({ ...p, order: rank.get(p.id) ?? ids.length + p.order })),
    }));
    this.emit();
  }

  async setActive(id: string | null): Promise<void> {
    if (id !== null) {
      this.require(id);
      const exists = await this.deps.fs.isDirectory(this.require(id).rootPath);
      if (exists === this.missing.has(id)) {
        if (exists) this.missing.delete(id);
        else this.missing.add(id);
        this.emit();
      }
    }
    const now = this.now();
    this.store.update((s) => ({
      ...s,
      activeProjectId: id,
      projects: id === null ? s.projects : s.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: now } : p)),
    }));
    this.activeEmitter.fire(id);
  }

  /** Removes a project from the list (terminals are handled by the caller). */
  remove(id: string): void {
    this.require(id);
    const remaining = this.list().filter((p) => p.id !== id);
    this.store.update((s) => ({
      ...s,
      projects: s.projects.filter((p) => p.id !== id),
      activeProjectId: s.activeProjectId === id ? (remaining[0]?.id ?? null) : s.activeProjectId,
    }));
    this.missing.delete(id);
    this.emit();
    this.activeEmitter.fire(this.store.get().activeProjectId);
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.activeEmitter.dispose();
  }
}
