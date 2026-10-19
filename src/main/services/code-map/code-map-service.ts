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
  private readonly statuses = new Map<string, CodeMapStatus>();
  private readonly configured = new Map<string, string>();
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
        if (this.deps.projects.get(status.checkoutId)?.settings.codeMap?.enabled) this.publish(status);
      }),
    );
    this.subscriptions.add(
      deps.host.onDidChangeState(({ state }) => {
        if (state === 'running' || state === 'starting' || state === 'stopped') return;
        this.configured.clear();
        for (const project of deps.projects.list())
          if (project.settings.codeMap?.enabled)
            this.publish({
              ...this.status(project.id),
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
    const project = this.project(id);
    const settings = CodeMapSettingsSchema.parse(project.settings.codeMap ?? {});
    return {
      checkoutId: id,
      projectId: id,
      root: project.rootPath,
      mode: 'project',
      excludedPaths: settings.excludedPaths,
      ignoreInGit: settings.ignoreInGit,
      gitPath: this.deps.gitPath(),
      removeGitignoreEntry: false,
    };
  }
  private async sync(): Promise<void> {
    const enabled = this.deps.projects.list().filter((p) => p.settings.codeMap?.enabled && !p.missing);
    const ids = new Set(enabled.map((p) => p.id));
    for (const id of this.configured.keys())
      if (!ids.has(id)) {
        if (this.deps.host.state === 'running') await this.deps.host.call('checkout:remove', { checkoutId: id });
        this.configured.delete(id);
      }
    for (const id of this.statuses.keys())
      if (!ids.has(id)) {
        this.publish(initialCodeMapStatus(id));
        this.statuses.delete(id);
      }
    if (!enabled.length) {
      if (this.deps.host.state !== 'stopped') await this.deps.host.stop();
      return;
    }
    if (this.deps.host.state === 'stopped' || this.deps.host.state === 'failed') this.deps.host.start();
    for (const project of enabled) {
      const config = this.config(project.id),
        signature = JSON.stringify(config);
      if (this.configured.get(project.id) === signature) continue;
      this.publish({ ...initialCodeMapStatus(project.id), state: 'indexing' });
      try {
        this.publish(await this.deps.host.call('checkout:configure', config, { timeoutMs: 60_000 }));
        this.configured.set(project.id, signature);
      } catch (error) {
        this.publish({
          ...this.status(project.id),
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
  private publish(status: CodeMapStatus): CodeMapStatus {
    this.statuses.set(status.checkoutId, status);
    this.changed.fire(structuredClone(status));
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
  }
}
