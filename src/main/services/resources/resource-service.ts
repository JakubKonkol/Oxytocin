import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  apiSecretKeys,
  type ApiResource,
  type BriefResource,
  buildAgentBrief,
  databaseSecretKeys,
  type DatabaseResource,
  emptyResources,
  type LinkResource,
  type LogResource,
  type ProjectResources,
  ProjectResourcesSchema,
  type SecretChange,
  validateResources,
} from '@shared/domain/project-resources';
import type { ResolvedApi, ResolvedDatabase } from '@shared/rpc/contracts/connections-host';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { type Disposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { JsonFileStore } from '../storage/json-file-store';
import type { SecretStore } from '../secrets/secret-store';

const ResourcesFileSchema = z.object({
  version: z.literal(1),
  /** Raw per project: an entry this version cannot read is kept as it is (a newer Oxytocin wrote it). */
  projects: z.record(z.string(), z.unknown()),
  /** Decisions about `.oxytocin/project.json` per project: the file's hash and whether it was accepted. */
  repositoryConfig: z.record(z.string(), z.object({ hash: z.string(), accepted: z.boolean() })).default({}),
});
type ResourcesFile = z.infer<typeof ResourcesFileSchema>;

export interface ResourceProject {
  id: string;
  name: string;
  rootPath: string;
}

export type Accessible =
  | { kind: 'database'; project: ResourceProject; own: boolean; resource: DatabaseResource }
  | { kind: 'api'; project: ResourceProject; own: boolean; resource: ApiResource }
  | { kind: 'log'; project: ResourceProject; own: boolean; resource: LogResource };

export interface ResourceServiceDeps {
  file: string;
  secrets: SecretStore;
  projects(): ResourceProject[];
  logger: Logger;
}

/** What changed after a save: resources whose pools and caches must be dropped. */
export interface ResourcesChange {
  projectId: string;
  /** `<projectId>/<resourceId>` of changed or removed databases and APIs. */
  changedKeys: string[];
}

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22);

/**
 * Project resources (Plan 02): stored in `project-resources.json` (not in projects.json, so a resource written by a
 * newer version can never make the project list unreadable), secrets in the SecretStore. Knows which resources an
 * agent in a project may use: its own exposed ones plus those of related projects shared with related projects.
 */
export class ResourceService implements Disposable {
  private readonly store: JsonFileStore<ResourcesFile>;
  private readonly changeEmitter = new Emitter<ResourcesChange>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly deps: ResourceServiceDeps) {
    this.store = new JsonFileStore({
      path: deps.file,
      schema: ResourcesFileSchema,
      defaults: () => ({ version: 1, projects: {}, repositoryConfig: {} }),
      debounceMs: 0,
      backup: true,
      logger: deps.logger,
    });
  }

  async load(): Promise<void> {
    await this.store.load();
  }

  /** The resources of a project; an unreadable entry reads as empty (and is kept until the user saves). */
  get(projectId: string): ProjectResources {
    const raw = this.store.get().projects[projectId];
    if (raw === undefined) return emptyResources();
    const parsed = ProjectResourcesSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.deps.logger.warn(
      `The resources of project ${projectId} could not be read: ${parsed.error.issues[0]?.message ?? ''}`,
    );
    return emptyResources();
  }

  /** True when the stored entry of a project could not be read (written by a newer version). */
  unreadable(projectId: string): boolean {
    const raw = this.store.get().projects[projectId];
    return raw !== undefined && !ProjectResourcesSchema.safeParse(raw).success;
  }

  private resourceKeys(r: ProjectResources): Map<string, string> {
    return new Map([...r.databases, ...r.apis].map((x) => [x.id, JSON.stringify(x)]));
  }

  /**
   * Saves a project's resources and applies secret changes (write-only). Relations are kept on both sides; secrets of
   * removed resources are deleted.
   */
  async save(projectId: string, input: unknown, secretChanges: SecretChange[] = []): Promise<ProjectResources> {
    const projects = this.deps.projects();
    if (!projects.some((p) => p.id === projectId)) throw new OxyError('NOT_FOUND', `Project ${projectId} not found`);
    const parsed = ProjectResourcesSchema.safeParse(input);
    if (!parsed.success) throw new OxyError('INVALID', `Invalid resources: ${parsed.error.issues[0]?.message ?? ''}`);
    const next = parsed.data;
    const problems = validateResources(next);
    if (problems.length) throw new OxyError('INVALID', problems.join(' '));
    next.relatedProjectIds = [...new Set(next.relatedProjectIds)].filter(
      (id) => id !== projectId && projects.some((p) => p.id === id),
    );
    const previous = this.get(projectId);
    const ids = new Set([...next.databases, ...next.apis].map((r) => r.id));
    for (const change of secretChanges) {
      if (!ids.has(change.resourceId))
        throw new OxyError('INVALID', `No database or API ${change.resourceId} in this project.`);
      if (change.value === null) await this.deps.secrets.delete(projectId, change.resourceId, change.key);
      else await this.deps.secrets.set(projectId, change.resourceId, change.key, change.value);
    }
    await this.deps.secrets.retain(projectId, ids);

    const before = this.resourceKeys(previous);
    const after = this.resourceKeys(next);
    const changedKeys = [...before.keys()]
      .filter((id) => before.get(id) !== after.get(id))
      .concat(secretChanges.map((c) => c.resourceId))
      .map((id) => `${projectId}/${id}`);

    this.store.update((s) => {
      const all = { ...s.projects, [projectId]: next };
      // Relations are stored on both sides.
      for (const other of projects) {
        if (other.id === projectId) continue;
        const raw = all[other.id];
        let current: ProjectResources;
        if (raw === undefined) current = emptyResources();
        else {
          const theirs = ProjectResourcesSchema.safeParse(raw);
          // An entry this version cannot read is left alone.
          if (!theirs.success) continue;
          current = theirs.data;
        }
        const linked = next.relatedProjectIds.includes(other.id);
        const has = current.relatedProjectIds.includes(projectId);
        if (linked === has) continue;
        all[other.id] = {
          ...current,
          relatedProjectIds: linked
            ? [...current.relatedProjectIds, projectId]
            : current.relatedProjectIds.filter((id) => id !== projectId),
        };
      }
      return { ...s, projects: all };
    });
    await this.store.flush();
    this.changeEmitter.fire({ projectId, changedKeys: [...new Set(changedKeys)] });
    return next;
  }

  /** Projects came or went (the kinds of resources agents can reach may differ): listeners recompute. */
  touch(): void {
    this.changeEmitter.fire({ projectId: '', changedKeys: [] });
  }

  /** A removed project: its resources, secrets and relations go away. */
  async removeProject(projectId: string): Promise<void> {
    const previous = this.get(projectId);
    this.store.update((s) => {
      const all: Record<string, unknown> = {};
      for (const [id, raw] of Object.entries(s.projects)) {
        if (id === projectId) continue;
        const parsed = ProjectResourcesSchema.safeParse(raw);
        all[id] =
          parsed.success && parsed.data.relatedProjectIds.includes(projectId)
            ? { ...parsed.data, relatedProjectIds: parsed.data.relatedProjectIds.filter((x) => x !== projectId) }
            : raw;
      }
      const decisions = { ...s.repositoryConfig };
      delete decisions[projectId];
      return { ...s, projects: all, repositoryConfig: decisions };
    });
    await this.store.flush();
    await this.deps.secrets.retain(projectId, null);
    this.changeEmitter.fire({
      projectId,
      changedKeys: [...previous.databases, ...previous.apis].map((r) => `${projectId}/${r.id}`),
    });
  }

  // ── what agents see ──

  /** The resources an agent in `projectId` may use: its own exposed ones and those related projects share. */
  accessible(projectId: string): Accessible[] {
    const projects = new Map(this.deps.projects().map((p) => [p.id, p]));
    const own = projects.get(projectId);
    if (!own) return [];
    const out: Accessible[] = [];
    const add = (project: ResourceProject, r: ProjectResources, isOwn: boolean) => {
      const visible = (a: { exposed: boolean; shareWithRelated: boolean }) =>
        a.exposed && (isOwn || a.shareWithRelated);
      for (const d of r.databases)
        if (visible(d.agents)) out.push({ kind: 'database', project, own: isOwn, resource: d });
      for (const a of r.apis) if (visible(a.agents)) out.push({ kind: 'api', project, own: isOwn, resource: a });
      for (const l of r.logs) if (visible(l.agents)) out.push({ kind: 'log', project, own: isOwn, resource: l });
    };
    const mine = this.get(projectId);
    add(own, mine, true);
    for (const id of mine.relatedProjectIds) {
      const other = projects.get(id);
      if (other) add(other, this.get(id), false);
    }
    return out;
  }

  links(projectId: string): LinkResource[] {
    return this.get(projectId).links;
  }

  /** Finds a resource by name or id (`project/name` for a related project's resource). */
  find<K extends Accessible['kind']>(projectId: string, kind: K, wanted: unknown): Extract<Accessible, { kind: K }> {
    const all = this.accessible(projectId).filter((a): a is Extract<Accessible, { kind: K }> => a.kind === kind);
    const label = kind === 'database' ? 'database' : kind === 'api' ? 'API' : 'log';
    const names = () =>
      all.map((a) => (a.own ? a.resource.name : `${a.project.name}/${a.resource.name}`)).join(', ') || 'none';
    if (typeof wanted !== 'string' || !wanted.trim()) {
      if (all.length === 1) return all[0]!;
      throw new Error(`Pass the ${label} name (${names()}).`);
    }
    const w = wanted.trim().toLowerCase();
    const matches = all.filter(
      (a) =>
        a.resource.id.toLowerCase() === w ||
        a.resource.name.toLowerCase() === w ||
        `${a.project.name}/${a.resource.name}`.toLowerCase() === w,
    );
    const own = matches.filter((a) => a.own);
    if (own.length === 1) return own[0]!;
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new Error(`Several ${label}s are named "${wanted}"; use "project/name" (${names()}).`);
    throw new Error(`No ${label} "${wanted}" in this project. Available: ${names()}. Call oxy_project_resources.`);
  }

  /** Which kinds of resources exist in any project (tools are only listed for these). */
  kinds(): Set<'sql' | 'mongodb' | 'redis' | 'api' | 'log' | 'any'> {
    const out = new Set<'sql' | 'mongodb' | 'redis' | 'api' | 'log' | 'any'>();
    for (const p of this.deps.projects()) {
      const r = this.get(p.id);
      const exposed = <T extends { agents: { exposed: boolean } }>(list: T[]) => list.filter((x) => x.agents.exposed);
      for (const d of exposed(r.databases)) {
        out.add(d.engine === 'mongodb' ? 'mongodb' : d.engine === 'redis' ? 'redis' : 'sql');
        out.add('any');
      }
      if (exposed(r.apis).length) out.add('api').add('any');
      if (exposed(r.logs).length) out.add('log').add('any');
      if (r.links.length) out.add('any');
    }
    return out;
  }

  /** The resources for the brief (no hosts of production resources, no secrets). */
  briefResources(
    projectId: string,
    baseUrl: (api: ApiResource, project: ResourceProject) => string | undefined,
  ): BriefResource[] {
    return this.accessible(projectId).map((a): BriefResource => {
      const from = a.own ? {} : { project: a.project.name };
      const description = a.resource.agents.description ? { description: a.resource.agents.description } : {};
      if (a.kind === 'database')
        return {
          kind: 'database',
          name: a.resource.name,
          engine: a.resource.engine,
          environment: a.resource.environment,
          mode: a.resource.access.mode,
          ...from,
          ...description,
        };
      if (a.kind === 'api') {
        const url = a.resource.environment === 'production' ? undefined : baseUrl(a.resource, a.project);
        return {
          kind: 'api',
          name: a.resource.name,
          environment: a.resource.environment,
          methods: [...new Set([...a.resource.access.methods, ...a.resource.access.confirmMethods])],
          ...(url ? { url } : {}),
          ...from,
          ...description,
        };
      }
      return { kind: 'log', name: a.resource.name, ...from, ...description };
    });
  }

  brief(projectId: string, baseUrl: (api: ApiResource, project: ResourceProject) => string | undefined): string {
    const project = this.deps.projects().find((p) => p.id === projectId);
    if (!project) return '';
    return buildAgentBrief(project.name, this.briefResources(projectId, baseUrl));
  }

  // ── resolving for the Connections Host ──

  resolveDatabase(
    project: ResourceProject,
    resource: DatabaseResource,
    secrets?: Record<string, string>,
  ): ResolvedDatabase {
    const values = secrets ?? this.deps.secrets.getAll(project.id, resource.id);
    const used = Object.fromEntries(
      databaseSecretKeys(resource)
        .filter((k) => values[k] !== undefined)
        .map((k) => [k, values[k]!]),
    );
    return {
      key: `${project.id}/${resource.id}`,
      resource,
      projectRoot: project.rootPath,
      secrets: used,
      fingerprint: fingerprint([resource.engine, resource.connection, resource.tls, resource.access, used]),
    };
  }

  resolveApi(
    project: ResourceProject,
    resource: ApiResource,
    baseUrl: string,
    secrets?: Record<string, string>,
  ): ResolvedApi {
    const values = secrets ?? this.deps.secrets.getAll(project.id, resource.id);
    const used = Object.fromEntries(
      apiSecretKeys(resource)
        .filter((k) => values[k] !== undefined)
        .map((k) => [k, values[k]!]),
    );
    return { key: `${project.id}/${resource.id}`, resource, projectRoot: project.rootPath, baseUrl, secrets: used };
  }

  /** Stored secrets of a resource merged with unsaved values typed in the dialog (for "Test connection"). */
  draftSecrets(projectId: string, resourceId: string, typed: Record<string, string | null>): Record<string, string> {
    const stored = this.deps.secrets.getAll(projectId, resourceId);
    for (const [k, v] of Object.entries(typed)) {
      if (v === null) delete stored[k];
      else stored[k] = v;
    }
    return stored;
  }

  // ── repository config decisions ──

  repositoryDecision(projectId: string): { hash: string; accepted: boolean } | undefined {
    return this.store.get().repositoryConfig[projectId];
  }

  async setRepositoryDecision(projectId: string, hash: string, accepted: boolean): Promise<void> {
    this.store.update((s) => ({ ...s, repositoryConfig: { ...s.repositoryConfig, [projectId]: { hash, accepted } } }));
    await this.store.flush();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
