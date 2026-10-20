import {
  CodeMapSettingsSchema,
  CodeMapStatusSchema,
  initialCodeMapStatus,
  type CodeMapSettings,
  type CodeMapStatus,
} from '@shared/domain/code-map';
import type {
  CodeMapHostMethods,
  CodeMapHostEvents,
  ConfigureCodeMapCheckout,
} from '@shared/rpc/contracts/code-map-host';
import type { Logger } from '@shared/logging/logger';
import { OxyError } from '@shared/errors';
import { DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CodeMapHostQuerySchema,
  CodeMapHostQueryResultSchema,
  CodeMapPluginRequestSchema,
  CodeMapLocatorSchema,
  CodeMapSourceLocationSchema,
  CodeMapCheckoutInfoSchema,
  type CodeMapChangeSchema,
  type CodeMapHostQueryInput,
  type CodeMapHostQueryResult,
  type CodeMapPluginRequest,
} from '@shared/domain/code-map-plugin';
import {
  CodeMapQueryResultSchema,
  CodeMapQuerySchema,
  type CodeMapQueryInput,
  type CodeMapQueryResult,
} from '@shared/domain/code-map-query';
import type { UtilityHost } from '../../hosts/utility-host';
import type { ProjectService } from '../projects/project-service';

type Host = Pick<
  UtilityHost<CodeMapHostMethods, CodeMapHostEvents>,
  'state' | 'start' | 'stop' | 'call' | 'onEvent' | 'onDidBecomeReady' | 'onDidChangeState'
>;

/** Owns project authorization and process lifetime; source and storage work stays in the host. */
export class CodeMapService {
  private readonly subscriptions = new DisposableStore();
  private readonly changed = new Emitter<CodeMapStatus>();
  readonly onDidChangeStatus = this.changed.event;
  private readonly checkoutChanged = new Emitter<z.infer<typeof CodeMapChangeSchema>>();
  readonly onDidChangeCheckout = this.checkoutChanged.event;
  private readonly owners = new Map<string, string>();
  private readonly statuses = new Map<string, CodeMapStatus>();
  private readonly configured = new Map<string, string>();
  private readonly worktrees = new Map<string, { projectId: string; root: string; projectRoot: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly deps: {
      host: Host;
      projects: Pick<ProjectService, 'list' | 'get' | 'update' | 'onDidChange'>;
      gitPath(): string;
      logger: Logger;
    },
  ) {
    this.subscriptions.add(deps.projects.onDidChange(() => this.schedule()));
    this.subscriptions.add(
      deps.host.onDidBecomeReady(({ restarted }) => {
        if (!deps.projects.list().some((p) => p.settings.codeMap?.enabled)) return;
        void this.enqueue(async () => {
          if (restarted) this.configured.clear();
          await this.sync();
        }).catch(this.log);
      }),
    );
    this.subscriptions.add(
      deps.host.onEvent('checkout:status', (raw) => {
        const status = CodeMapStatusSchema.parse(raw);
        const projectId = this.worktrees.get(status.checkoutId)?.projectId ?? status.checkoutId;
        if (this.deps.projects.get(projectId)?.settings.codeMap?.enabled) this.publish(status);
      }),
    );
    this.subscriptions.add(
      deps.host.onDidChangeState(({ state }) => {
        if (state === 'running' || state === 'starting' || state === 'stopped') return;
        this.configured.clear();
        for (const checkout of this.registeredCheckouts())
          if (deps.projects.get(checkout.projectId)?.settings.codeMap?.enabled)
            this.publish({
              ...(this.statuses.get(checkout.id) ?? initialCodeMapStatus(checkout.id)),
              state: 'error',
              error:
                state === 'failed'
                  ? 'Code Map Host failed. Rebuild to retry.'
                  : 'Code Map Host is restarting; freshness is unknown.',
            });
      }),
    );
  }

  private readonly log = (error: unknown) => this.deps.logger.warn('Code Map operation failed', error);
  start(): Promise<void> {
    return this.enqueue(() => this.sync());
  }
  private schedule(): void {
    void this.start().catch(this.log);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new OxyError('UNAVAILABLE', 'Code Map service stopped');
      return operation();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private project(id: string) {
    const project = this.deps.projects.get(id);
    if (!project) throw new OxyError('NOT_FOUND', 'Project not found');
    return project;
  }
  private config(id: string): ConfigureCodeMapCheckout {
    const worktree = this.worktrees.get(id);
    const project = this.project(worktree?.projectId ?? id);
    const settings = CodeMapSettingsSchema.parse(project.settings.codeMap ?? {});
    return {
      checkoutId: id,
      projectId: project.id,
      root: worktree?.root ?? project.rootPath,
      mode: worktree ? 'worktree' : 'project',
      excludedPaths: settings.excludedPaths,
      ignoreInGit: worktree ? true : settings.ignoreInGit,
      gitPath: this.deps.gitPath(),
      removeGitignoreEntry: false,
    };
  }
  private async sync(): Promise<void> {
    const enabled = this.deps.projects.list().filter((p) => p.settings.codeMap?.enabled && !p.missing);
    const ids = new Set(enabled.map((p) => p.id));
    for (const [id, tree] of this.worktrees) {
      if (ids.has(tree.projectId) && this.deps.projects.get(tree.projectId)?.rootPath === tree.projectRoot) ids.add(id);
    }
    for (const id of this.configured.keys())
      if (!ids.has(id)) {
        if (this.deps.host.state === 'running') await this.deps.host.call('checkout:remove', { checkoutId: id });
        this.configured.delete(id);
      }
    for (const id of this.statuses.keys())
      if (!ids.has(id)) {
        this.publish(initialCodeMapStatus(id));
        this.statuses.delete(id);
        this.owners.delete(id);
      }
    if (!enabled.length) {
      if (this.deps.host.state !== 'stopped') await this.deps.host.stop();
      return;
    }
    if (this.deps.host.state === 'stopped' || this.deps.host.state === 'failed') this.deps.host.start();
    for (const id of ids) {
      const config = this.config(id),
        signature = JSON.stringify(config);
      if (this.configured.get(id) === signature) continue;
      this.publish({ ...initialCodeMapStatus(id), state: 'indexing' });
      try {
        this.publish(await this.deps.host.call('checkout:configure', config, { timeoutMs: 60_000 }));
        this.configured.set(id, signature);
      } catch (error) {
        this.publish({
          ...(this.statuses.get(id) ?? initialCodeMapStatus(id)),
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        this.log(error);
      }
    }
  }
  status(id: string): CodeMapStatus {
    this.project(id);
    return structuredClone(this.statuses.get(id) ?? initialCodeMapStatus(id));
  }
  async registerWorktree(projectId: string, taskId: string, root: string): Promise<string> {
    const checkoutId = `worktree:${taskId}`;
    await this.enqueue(async () => {
      const project = this.project(projectId);
      this.worktrees.set(checkoutId, { projectId, root: await realpath(root), projectRoot: project.rootPath });
      this.owners.set(checkoutId, projectId);
      await this.sync();
    });
    return checkoutId;
  }
  removeWorktree(taskId: string): Promise<void> {
    // Revoke immediately, before any queued host operation or filesystem deletion.
    this.worktrees.delete(`worktree:${taskId}`);
    return this.enqueue(() => this.sync());
  }
  registeredCheckouts(): { id: string; projectId: string; name: string; rootPath: string }[] {
    return [
      ...this.deps.projects
        .list()
        .filter((p) => !p.missing)
        .map((p) => ({ id: p.id, projectId: p.id, name: p.name, rootPath: p.rootPath })),
      ...[...this.worktrees].flatMap(([id, tree]) => {
        const p = this.deps.projects.get(tree.projectId);
        return p && !p.missing && p.rootPath === tree.projectRoot
          ? [{ id, projectId: p.id, name: `${p.name} worktree`, rootPath: tree.root }]
          : [];
      }),
    ];
  }
  checkoutRoot(projectId: string, checkoutId = projectId): string {
    const project = this.project(projectId);
    if (!project.settings.codeMap?.enabled || project.missing)
      throw new OxyError('UNAVAILABLE', 'Code Map is disabled or the project is unavailable');
    if (checkoutId === projectId) return project.rootPath;
    const tree = this.worktrees.get(checkoutId);
    if (!tree || tree.projectId !== projectId || tree.projectRoot !== project.rootPath)
      throw new OxyError('UNAVAILABLE', 'Code Map checkout is no longer registered');
    return tree.root;
  }
  editInstructions(
    id: string,
    file: 'CLAUDE.md' | 'AGENTS.md',
    action: 'add' | 'remove',
  ): Promise<{ changed: boolean }> {
    return this.enqueue(async () => {
      const project = this.project(id);
      if (this.deps.host.state === 'stopped' || this.deps.host.state === 'failed') this.deps.host.start();
      try {
        return await this.deps.host.call('instructions:edit', { root: project.rootPath, file, action });
      } finally {
        await this.sync();
      }
    });
  }
  private publish(status: CodeMapStatus): CodeMapStatus {
    this.statuses.set(status.checkoutId, status);
    this.changed.fire(structuredClone(status));
    this.checkoutChanged.fire({
      projectId: this.owners.get(status.checkoutId) ?? status.checkoutId,
      checkoutId: status.checkoutId,
      generation: status.generation,
      state: status.state,
    });
    return status;
  }

  async setEnabled(id: string, enabled: boolean, ignoreInGit?: boolean): Promise<CodeMapStatus> {
    return this.enqueue(async () => {
      const project = this.project(id),
        current = CodeMapSettingsSchema.parse(project.settings.codeMap ?? {});
      await this.deps.projects.update({
        id,
        settings: {
          ...project.settings,
          codeMap: { ...current, enabled, ...(ignoreInGit === undefined ? {} : { ignoreInGit }) },
        },
      });
      await this.sync();
      return this.status(id);
    });
  }
  async setOptions(
    id: string,
    options: Pick<CodeMapSettings, 'excludedPaths' | 'ignoreInGit'>,
    removeGitignoreEntry: boolean,
  ): Promise<CodeMapStatus> {
    return this.enqueue(async () => {
      const project = this.project(id),
        current = CodeMapSettingsSchema.parse(project.settings.codeMap ?? {});
      await this.deps.projects.update({ id, settings: { ...project.settings, codeMap: { ...current, ...options } } });
      if (current.enabled && removeGitignoreEntry) {
        const config = this.config(id);
        this.publish(
          await this.deps.host.call(
            'checkout:configure',
            { ...config, removeGitignoreEntry: true },
            { timeoutMs: 60_000 },
          ),
        );
        this.configured.set(id, JSON.stringify(config));
      }
      await this.sync();
      return this.status(id);
    });
  }
  action(id: string, action: 'rebuild' | 'pause' | 'resume'): Promise<CodeMapStatus> {
    return this.enqueue(async () => {
      if (!this.project(id).settings.codeMap?.enabled) throw new OxyError('INVALID', 'Enable Code Map first');
      await this.sync();
      return this.publish(await this.deps.host.call(`checkout:${action}`, { checkoutId: id }));
    });
  }
  diagnostics(id: string) {
    return this.enqueue(async () => {
      this.project(id);
      if (!this.configured.has(id)) return { skipped: [], failed: [], unresolved: [], truncated: false };
      return this.deps.host.call('checkout:diagnostics', { checkoutId: id });
    });
  }
  async query(id: string, input: CodeMapQueryInput, signal: AbortSignal, checkoutId = id): Promise<CodeMapQueryResult> {
    return CodeMapQueryResultSchema.parse(await this.runQuery(id, CodeMapQuerySchema.parse(input), signal, checkoutId));
  }
  async pluginQuery(input: CodeMapPluginRequest, signal: AbortSignal): Promise<CodeMapHostQueryResult> {
    const { projectId, checkoutId, ...query } = CodeMapPluginRequestSchema.parse(input);
    const result = await this.runQuery(projectId, query, signal, checkoutId);
    if (query.kind === 'slice' && result.data) {
      const current = CodeMapStatusSchema.parse(await this.deps.host.call('checkout:status', { checkoutId }));
      this.checkoutRoot(projectId, checkoutId);
      signal.throwIfAborted();
      if (current.generation !== result.freshness.generation)
        return {
          ...result,
          data: undefined,
          code: 'SNAPSHOT_CHANGED',
          freshness: { ...result.freshness, stale: true },
          hint: 'The generation changed while the response was in flight; refresh the view.',
        };
    }
    return result;
  }
  listCheckouts(projectId: string) {
    this.project(projectId);
    if (!this.deps.projects.get(projectId)?.settings.codeMap?.enabled) return [];
    return z.array(CodeMapCheckoutInfoSchema).parse(
      this.registeredCheckouts()
        .filter((c) => c.projectId === projectId)
        .map((c) => ({
          projectId,
          checkoutId: c.id,
          label: c.id === projectId ? 'Main checkout' : c.name,
          mode: c.id === projectId ? 'project' : 'worktree',
        })),
    );
  }
  checkoutStatus(projectId: string, checkoutId: string): CodeMapStatus {
    this.checkoutRoot(projectId, checkoutId);
    return structuredClone(this.statuses.get(checkoutId) ?? initialCodeMapStatus(checkoutId));
  }
  async locateSource(
    input: z.input<typeof CodeMapLocatorSchema>,
  ): Promise<{ path: string; line: number; column: number }> {
    const locator = CodeMapLocatorSchema.parse(input),
      root = this.checkoutRoot(locator.projectId, locator.checkoutId);
    await this.enqueue(() => this.sync());
    if (this.checkoutRoot(locator.projectId, locator.checkoutId) !== root)
      throw new OxyError('UNAVAILABLE', 'Code Map checkout changed');
    const location = CodeMapSourceLocationSchema.parse(await this.deps.host.call('source:locate', locator));
    if (this.checkoutRoot(locator.projectId, locator.checkoutId) !== root)
      throw new OxyError('UNAVAILABLE', 'Code Map checkout changed');
    return { path: join(root, ...location.path.split('/')), line: location.line, column: location.column + 1 };
  }
  private async runQuery(
    id: string,
    input: CodeMapHostQueryInput,
    signal: AbortSignal,
    checkoutId: string,
  ): Promise<CodeMapHostQueryResult> {
    const query = CodeMapHostQuerySchema.parse(input);
    const authorize = () => {
      return this.checkoutRoot(id, checkoutId);
    };
    const root = authorize();
    signal.throwIfAborted();
    // Only configuration is serialized; concurrent readers must not block disable or each other.
    await this.enqueue(() => this.sync());
    if (authorize() !== root) throw new OxyError('UNAVAILABLE', 'Code Map checkout changed');
    signal.throwIfAborted();
    const requestId = randomUUID();
    const abort = () => {
      void this.deps.host.call('query:cancel', { requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = CodeMapHostQueryResultSchema.parse(
        await this.deps.host.call('query:run', { checkoutId, requestId, query }, { timeoutMs: 10_000 }),
      );
      signal.throwIfAborted();
      if (authorize() !== root || result.checkoutId !== checkoutId)
        throw new OxyError('UNAVAILABLE', 'Code Map checkout changed');
      if (
        query.kind === 'slice'
          ? Buffer.byteLength(JSON.stringify(result)) > 512 * 1024
          : JSON.stringify(result).length > query.maxChars
      )
        throw new OxyError('INVALID', 'Code Map response exceeds the character budget');
      return result;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  deleteData(id: string): Promise<CodeMapStatus> {
    return this.enqueue(async () => {
      const project = this.project(id);
      await this.deps.projects.update({
        id,
        settings: {
          ...project.settings,
          codeMap: { ...CodeMapSettingsSchema.parse(project.settings.codeMap ?? {}), enabled: false },
        },
      });
      if (this.deps.host.state === 'stopped' || this.deps.host.state === 'failed') this.deps.host.start();
      try {
        const status = await this.deps.host.call(
          'checkout:deleteData',
          { checkoutId: id, root: project.rootPath },
          { timeoutMs: 60_000 },
        );
        this.configured.delete(id);
        return this.publish(status);
      } finally {
        await this.sync();
      }
    });
  }
  async dispose(): Promise<void> {
    this.subscriptions.dispose();
    await this.queue;
    this.closed = true;
    this.changed.dispose();
    this.checkoutChanged.dispose();
  }
}
