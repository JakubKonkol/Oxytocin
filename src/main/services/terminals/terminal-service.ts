import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { Settings } from '@shared/domain/settings';
import type { CreateTerminalRequest, TerminalInfo } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { PtyHostEvents, PtyHostMethods } from '@shared/rpc/contracts/pty-host';
import type { Logger } from '@shared/logging/logger';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { UtilityHost } from '../../hosts/utility-host';
import { composeEnv, type EnvLayer } from './env-composer';
import type { ProfileService } from './profiles';

export interface ProjectContext {
  rootPath: string;
  env?: EnvLayer;
}

export interface TerminalServiceDeps {
  ptyHost: Pick<UtilityHost<PtyHostMethods, PtyHostEvents>, 'call' | 'onEvent' | 'onDidBecomeReady'>;
  profiles: ProfileService;
  settings: () => Settings;
  resolveProject: (projectId: string) => ProjectContext | null;
  baseEnv: () => EnvLayer | Promise<EnvLayer>;
  /** Environment contributions from plugins (M5); applied after project env. */
  pluginEnv?: (ctx: { projectId: string; profileId: string }) => EnvLayer[];
  appVersion: string;
  dev: boolean;
  platform: NodeJS.Platform;
  logger: Logger;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Main-side registry of terminals: creates them in the PTY Host and tracks their TerminalInfo. */
export class TerminalService implements Disposable {
  private readonly terminals = new Map<string, TerminalInfo>();
  private readonly requests = new Map<string, CreateTerminalRequest>();
  private readonly store = new DisposableStore();
  private readonly updatedEmitter = new Emitter<TerminalInfo>();
  readonly onDidUpdate = this.updatedEmitter.event;
  private readonly removedEmitter = new Emitter<string>();
  readonly onDidRemove = this.removedEmitter.event;

  constructor(private readonly deps: TerminalServiceDeps) {
    const pty = deps.ptyHost;
    this.store.add(pty.onEvent('terminal:exit', (e) => this.patch(e.id, { state: 'exited', exitCode: e.exitCode })));
    this.store.add(pty.onEvent('terminal:title', (e) => this.patch(e.id, { oscTitle: e.title })));
    this.store.add(pty.onEvent('terminal:bell', (e) => this.patch(e.id, { bell: true })));
    this.store.add(pty.onEvent('terminal:cwd', (e) => this.patch(e.id, { cwd: e.cwd })));
    this.store.add(
      pty.onEvent('terminal:progress', (e) =>
        this.patch(e.id, { progress: e.value === undefined ? { state: e.state } : { state: e.state, value: e.value } }),
      ),
    );
    this.store.add(
      pty.onDidBecomeReady(({ restarted }) => {
        if (!restarted) return;
        for (const info of this.terminals.values()) {
          if (info.state === 'running') {
            this.patch(info.id, { state: 'failed', pid: null, error: 'Disconnected — the PTY host crashed' });
          }
        }
      }),
    );
  }

  private withTitle(info: TerminalInfo): TerminalInfo {
    return { ...info, title: info.userTitle ?? info.oscTitle ?? info.profileName };
  }

  private patch(id: string, patch: Partial<TerminalInfo>): void {
    const current = this.terminals.get(id);
    if (!current) return;
    const next = this.withTitle({ ...current, ...patch });
    this.terminals.set(id, next);
    this.updatedEmitter.fire(next);
  }

  get(id: string): TerminalInfo | undefined {
    return this.terminals.get(id);
  }

  list(projectId?: string): TerminalInfo[] {
    const all = [...this.terminals.values()];
    return projectId ? all.filter((t) => t.projectId === projectId) : all;
  }

  private require(id: string): TerminalInfo {
    const info = this.terminals.get(id);
    if (!info) throw new OxyError('NOT_FOUND', `Terminal ${id} not found`);
    return info;
  }

  async create(req: CreateTerminalRequest): Promise<TerminalInfo> {
    const project = this.deps.resolveProject(req.projectId);
    if (!project) throw new OxyError('NOT_FOUND', `Project ${req.projectId} not found`);
    const cwd = req.cwd && (await isDirectory(req.cwd)) ? req.cwd : project.rootPath;
    if (!(await isDirectory(cwd))) throw new OxyError('NOT_FOUND', `Folder not found: ${cwd}`);
    const launch = await this.deps.profiles.resolveLaunch(req.profileId, cwd);
    const settings = this.deps.settings();
    const id = `t-${randomUUID().slice(0, 12)}`;
    const env = composeEnv({
      platform: this.deps.platform,
      base: await this.deps.baseEnv(),
      dev: this.deps.dev,
      appVersion: this.deps.appVersion,
      projectId: req.projectId,
      terminalId: id,
      layers: [
        settings['terminal.env'],
        project.env ?? {},
        ...(this.deps.pluginEnv?.({ projectId: req.projectId, profileId: launch.profile.id }) ?? []),
        launch.env,
      ],
    });
    const initialCommand = req.initialCommand ?? launch.initialCommand;
    const { pid } = await this.deps.ptyHost.call('spawn', {
      id,
      file: launch.file,
      args: launch.args,
      cwd,
      env,
      cols: req.cols ?? DEFAULT_COLS,
      rows: req.rows ?? DEFAULT_ROWS,
      scrollback: settings['terminal.scrollback'],
      useConptyDll: settings['terminal.windows.useBundledConpty'],
      ...(req.restoreData ? { restoreData: req.restoreData } : {}),
      ...(initialCommand ? { initialCommand } : {}),
    });
    const info = this.withTitle({
      id,
      projectId: req.projectId,
      profileId: launch.profile.id,
      profileName: launch.profile.name,
      title: launch.profile.name,
      ...(req.userTitle ? { userTitle: req.userTitle } : {}),
      pid,
      cwd,
      shellType: launch.shellType,
      kind: launch.profile.kind === 'agent' ? 'agent' : 'shell',
      state: 'running',
      createdAt: Date.now(),
      envStale: false,
      bell: false,
    });
    this.terminals.set(id, info);
    this.requests.set(id, { ...req, cwd });
    this.deps.logger.info(`Terminal ${id} created (${launch.profile.id}, pid ${pid})`);
    this.updatedEmitter.fire(info);
    return info;
  }

  async kill(id: string, force = false): Promise<void> {
    const info = this.require(id);
    if (info.state !== 'running') return;
    await this.deps.ptyHost.call('kill', { id, force });
  }

  /** Restart = a new terminal (new id) with the same profile/cwd; the caller swaps it into the same panel. */
  async restart(id: string): Promise<TerminalInfo> {
    const info = this.require(id);
    const req = this.requests.get(id);
    await this.close(id);
    const { restoreData: _restore, ...rest } = req ?? {
      projectId: info.projectId,
      profileId: info.profileId,
      cwd: info.cwd,
    };
    return this.create({
      ...rest,
      projectId: info.projectId,
      profileId: info.profileId,
      cwd: info.cwd,
      ...(info.userTitle ? { userTitle: info.userTitle } : {}),
    });
  }

  rename(id: string, title: string): void {
    this.require(id);
    const trimmed = title.trim();
    const current = this.terminals.get(id)!;
    const { userTitle: _old, ...rest } = current;
    const next = this.withTitle(trimmed ? { ...rest, userTitle: trimmed } : rest);
    this.terminals.set(id, next);
    this.updatedEmitter.fire(next);
  }

  /** Clears the bell indicator (the user looked at the terminal). */
  clearBell(id: string): void {
    if (this.terminals.get(id)?.bell) this.patch(id, { bell: false });
  }

  /** Kills the process (if running) and forgets the terminal. */
  async close(id: string): Promise<void> {
    const info = this.terminals.get(id);
    if (!info) return;
    this.terminals.delete(id);
    this.requests.delete(id);
    try {
      if (info.state === 'running') await this.deps.ptyHost.call('kill', { id, force: false });
      await this.deps.ptyHost.call('dispose', { id });
    } catch (e) {
      this.deps.logger.debug(`Terminal ${id}: dispose failed`, e);
    }
    this.removedEmitter.fire(id);
  }

  dispose(): void {
    this.store.dispose();
    this.updatedEmitter.dispose();
    this.removedEmitter.dispose();
  }
}
