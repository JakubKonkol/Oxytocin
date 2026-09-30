import { relative, isAbsolute } from 'node:path';
import {
  ApiResourceSchema,
  type ApiResource,
  DatabaseResourceSchema,
  type ImportCandidate,
  type ProjectResources,
  type ResourceTestResult,
  type SecretChange,
  SHARED_CONFIG_PATH,
} from '@shared/domain/project-resources';
import type { ConnectionsHostMethods } from '@shared/rpc/contracts/connections-host';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { type Disposable, DisposableStore, toDisposable } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { buildResourceTools, type ResourceTool } from '../mcp/resource-tools';
import type { SecretStore } from '../secrets/secret-store';
import { mergeSharedConfig, readSharedConfig, writeInstructionsBlock, writeSharedConfig } from './repository-files';
import type { ResourceProject, ResourceService } from './resource-service';

/** The Connections Host as the controller uses it (started on demand, stopped when idle). */
export interface ConnectionsHostPort {
  call<M extends Extract<keyof ConnectionsHostMethods, string>>(
    method: M,
    params: Parameters<ConnectionsHostMethods[M]>[0],
    opts?: { timeoutMs?: number },
  ): Promise<Awaited<ReturnType<ConnectionsHostMethods[M]>>>;
  running(): boolean;
  start(): void;
  stop(): Promise<void>;
}

export interface ResourcesControllerDeps {
  resources: ResourceService;
  secrets: SecretStore;
  host: ConnectionsHostPort;
  projects(): ResourceProject[];
  /** Terminal → its project (for the Claude Code session brief). */
  terminalProject(terminalId: string): string | undefined;
  /** A Project Runner profile's URL (null when the runner cannot tell, e.g. it is disabled). */
  runProfileUrl(projectId: string, profileId: string): Promise<string | null>;
  /** Asks the user in the window; null when nobody answered or the window is gone. */
  confirm(o: {
    title: string;
    description: string;
    details?: string[];
    code?: string;
    confirmLabel: string;
    cancelLabel: string;
    tone: 'info' | 'warning' | 'danger';
    signal?: AbortSignal;
  }): Promise<boolean | null>;
  logger: Logger;
  /** Stop the Connections Host after this long without calls (default 10 minutes). */
  idleStopMs?: number;
  now?: () => number;
}

const IDLE_STOP_MS = 10 * 60_000;

/**
 * Glue between the resource settings, the secret store, the Connections Host and the agent tools: resolves secrets
 * and base URLs, keeps the managed block of AGENTS.md/CLAUDE.md up to date, asks about `.oxytocin/project.json`,
 * closes pools of changed resources and stops the host when it is idle (its drivers use memory).
 */
export class ResourcesController implements Disposable {
  private readonly store = new DisposableStore();
  private lastUse = 0;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private readonly asked = new Set<string>();
  private readonly changedEmitter = new Emitter<string>();
  /** A project's resources changed (for the renderer). */
  readonly onDidChange = this.changedEmitter.event;
  readonly tools: ResourceTool[];
  private readonly now: () => number;

  constructor(private readonly deps: ResourcesControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.tools = buildResourceTools({
      resources: deps.resources,
      host: (method, params, opts) => this.call(method, params, opts),
      projects: () => deps.projects(),
      baseUrl: (api, project) => this.baseUrl(api, project),
      confirm: async ({ title, description, code, details, signal }) =>
        deps.confirm({
          title,
          description,
          code,
          details,
          confirmLabel: 'Allow',
          cancelLabel: 'Deny',
          tone: 'danger',
          signal,
        }),
    });
    this.store.add(
      deps.resources.onDidChange(({ projectId, changedKeys }) => {
        if (changedKeys.length && deps.host.running())
          void deps.host.call('db:close', { keys: changedKeys }).catch(() => undefined);
        if (!projectId) return;
        this.changedEmitter.fire(projectId);
        void this.refreshInstructions(projectId);
      }),
    );
    this.idleTimer = setInterval(() => {
      if (deps.host.running() && this.now() - this.lastUse > (deps.idleStopMs ?? IDLE_STOP_MS)) {
        deps.logger.info('Stopping the idle Connections Host');
        void deps.host.stop();
      }
    }, 60_000);
    this.idleTimer.unref?.();
    this.store.add(toDisposable(() => clearInterval(this.idleTimer)));
  }

  private call: ResourcesControllerDeps['host']['call'] = (method, params, opts) => {
    this.lastUse = this.now();
    if (!this.deps.host.running()) this.deps.host.start();
    return this.deps.host.call(method, params, opts);
  };

  private project(projectId: string): ResourceProject {
    const p = this.deps.projects().find((x) => x.id === projectId);
    if (!p) throw new OxyError('NOT_FOUND', `Project ${projectId} not found`);
    return p;
  }

  /** The base URL of an API; for a run profile, its URL while it runs (else the fallback). */
  async baseUrl(api: ApiResource, project: ResourceProject): Promise<string> {
    if (typeof api.baseUrl === 'string') return api.baseUrl;
    const url = await this.deps.runProfileUrl(project.id, api.baseUrl.runProfileId).catch(() => null);
    if (url) return url;
    if (api.baseUrl.fallback) return api.baseUrl.fallback;
    throw new Error(
      `The base URL of "${api.name}" comes from a Run profile that is not running. Start it with run_start_profile (Project Runner tools), then try again.`,
    );
  }

  /** The brief with static URLs only (it must not wait for the runner). */
  brief(projectId: string): string {
    return this.deps.resources.brief(projectId, (api) =>
      typeof api.baseUrl === 'string' ? api.baseUrl : api.baseUrl.fallback,
    );
  }

  /** The Claude Code session brief of a terminal's project, unless the project turned it off. */
  sessionBrief(terminalId: string): string | null {
    const projectId = this.deps.terminalProject(terminalId);
    if (!projectId) return null;
    if (!this.deps.resources.get(projectId).agentBrief.sessionHook) return null;
    return this.brief(projectId) || null;
  }

  // ── IPC ──

  async get(projectId: string) {
    const project = this.project(projectId);
    const shared = await readSharedConfig(project.rootPath).catch(() => null);
    return {
      resources: this.deps.resources.get(projectId),
      secrets: this.deps.secrets.status(projectId),
      unreadable: this.deps.resources.unreadable(projectId),
      repositoryFile: shared !== null,
    };
  }

  async save(projectId: string, input: unknown, changes: SecretChange[]): Promise<ProjectResources> {
    const project = this.project(projectId);
    const resolved: SecretChange[] = [];
    for (const c of changes) {
      if (c.importToken) {
        const { value } = await this.call('import:secret', { root: project.rootPath, token: c.importToken });
        if (value === null) throw new OxyError('INVALID', 'The imported connection expired; import it again.');
        resolved.push({ resourceId: c.resourceId, key: c.key, value });
      } else resolved.push(c);
    }
    return this.deps.resources.save(projectId, input, resolved);
  }

  async test(o: {
    projectId: string;
    kind: 'database' | 'api';
    resource: unknown;
    secrets: Record<string, string | null>;
    importTokens: Record<string, string>;
  }): Promise<ResourceTestResult> {
    const project = this.project(o.projectId);
    const typed = { ...o.secrets };
    for (const [key, token] of Object.entries(o.importTokens)) {
      const { value } = await this.call('import:secret', { root: project.rootPath, token });
      if (value !== null) typed[key] = value;
    }
    if (o.kind === 'database') {
      const parsed = DatabaseResourceSchema.safeParse(o.resource);
      if (!parsed.success)
        return { ok: false, error: { kind: 'config', message: parsed.error.issues[0]?.message ?? 'Invalid settings' } };
      const secrets = this.deps.resources.draftSecrets(o.projectId, parsed.data.id, typed);
      const db = this.deps.resources.resolveDatabase(project, parsed.data, secrets);
      return this.call('db:test', { ...db, key: `${db.key}#test` }, { timeoutMs: 60_000 });
    }
    const parsed = ApiResourceSchema.safeParse(o.resource);
    if (!parsed.success)
      return { ok: false, error: { kind: 'config', message: parsed.error.issues[0]?.message ?? 'Invalid settings' } };
    let baseUrl: string;
    try {
      baseUrl = await this.baseUrl(parsed.data, project);
    } catch (e) {
      return { ok: false, error: { kind: 'config', message: e instanceof Error ? e.message : String(e) } };
    }
    const secrets = this.deps.resources.draftSecrets(o.projectId, parsed.data.id, typed);
    const api = this.deps.resources.resolveApi(project, parsed.data, baseUrl, secrets);
    return this.call('api:test', { ...api, key: `${api.key}#test` }, { timeoutMs: 60_000 });
  }

  importCandidates(projectId: string): Promise<ImportCandidate[]> {
    return this.call('import:scan', { root: this.project(projectId).rootPath }, { timeoutMs: 60_000 });
  }

  /** Writes the managed block now and remembers the choice (kept up to date on every change). */
  async writeInstructions(projectId: string, file: 'none' | 'AGENTS.md' | 'CLAUDE.md') {
    const project = this.project(projectId);
    const current = this.deps.resources.get(projectId);
    const previous = current.agentBrief.instructionsFile;
    // Leaving a file: its block is removed.
    if (previous !== 'none' && previous !== file) await writeInstructionsBlock(project.rootPath, previous, '');
    if (previous !== file)
      await this.deps.resources.save(projectId, {
        ...current,
        agentBrief: { ...current.agentBrief, instructionsFile: file },
      });
    if (file === 'none') return { path: null, written: previous !== 'none' };
    return writeInstructionsBlock(project.rootPath, file, this.brief(projectId));
  }

  private async refreshInstructions(projectId: string): Promise<void> {
    const project = this.deps.projects().find((p) => p.id === projectId);
    if (!project) return;
    const file = this.deps.resources.get(projectId).agentBrief.instructionsFile;
    if (file === 'none') return;
    try {
      await writeInstructionsBlock(project.rootPath, file, this.brief(projectId));
    } catch (e) {
      this.deps.logger.warn(`Could not update the resources block in ${file}`, e);
    }
  }

  saveToRepository(projectId: string): Promise<string> {
    const project = this.project(projectId);
    return writeSharedConfig(project.rootPath, this.deps.resources.get(projectId));
  }

  /** The picked path, relative to the project root when inside it. */
  relativePath(projectId: string, path: string): string {
    const project = this.project(projectId);
    const rel = relative(project.rootPath, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : path;
  }

  /**
   * `.oxytocin/project.json`: asks once per file version whether to use the resources it defines (a repository could
   * otherwise point agents at hosts the user did not choose). Accepted resources are added to the local settings.
   */
  async checkRepositoryConfig(projectId: string): Promise<void> {
    const project = this.deps.projects().find((p) => p.id === projectId);
    if (!project) return;
    let file;
    try {
      file = await readSharedConfig(project.rootPath);
    } catch (e) {
      this.deps.logger.warn(`${project.name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!file) return;
    const decided = this.deps.resources.repositoryDecision(projectId);
    const key = `${projectId}:${file.hash}`;
    if (decided?.hash === file.hash || this.asked.has(key)) return;
    this.asked.add(key);
    const r = file.config.resources;
    const counts = [
      r.databases.length ? `${r.databases.length} database${r.databases.length === 1 ? '' : 's'}` : '',
      r.apis.length ? `${r.apis.length} API${r.apis.length === 1 ? '' : 's'}` : '',
      r.links.length ? `${r.links.length} link${r.links.length === 1 ? '' : 's'}` : '',
      r.logs.length ? `${r.logs.length} log file${r.logs.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    if (counts.length === 0) return;
    const answer = await this.deps.confirm({
      title: `Use the resources defined in ${project.name}?`,
      description: `This repository (${SHARED_CONFIG_PATH}) defines ${counts.join(', ')} for AI agents. Use them only if you trust the repository: they decide which hosts agents reach through Oxytocin. Secrets are never in the file; you enter them in Project settings.`,
      details: [
        ...r.databases.map(
          (d) => `Database ${d.name}: ${d.engine}${d.connection.kind === 'fields' ? ` at ${d.connection.host}` : ''}`,
        ),
        ...r.apis.map((a) => `API ${a.name}: ${typeof a.baseUrl === 'string' ? a.baseUrl : 'from a Run profile'}`),
        ...r.logs.map((l) => `Log ${l.name}: ${l.path}`),
      ].slice(0, 40),
      confirmLabel: 'Use them',
      cancelLabel: 'Not now',
      tone: 'warning',
    });
    if (answer === null) {
      this.asked.delete(key);
      return;
    }
    if (answer) {
      const merged = mergeSharedConfig(this.deps.resources.get(projectId), file.config);
      await this.deps.resources.save(projectId, merged);
    }
    await this.deps.resources.setRepositoryDecision(projectId, file.hash, answer);
  }

  dispose(): void {
    this.store.dispose();
    this.changedEmitter.dispose();
  }
}
