import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { Settings } from '@shared/domain/settings';
import type { AgentInfo } from '@shared/domain/agent';
import type { CreateTerminalRequest, TerminalInfo, TerminalKind } from '@shared/domain/terminal';
import { OxyError } from '@shared/errors';
import type { PtyHostEvents, PtyHostMethods } from '@shared/rpc/contracts/pty-host';
import type { Logger } from '@shared/logging/logger';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { UtilityHost } from '../../hosts/utility-host';
import { composeEnv, type EnvLayer } from './env-composer';
import { withSeparator } from './scrollback-format';
import type { ProfileService } from './profiles';
import { injectShellIntegration, type ShellIntegrationScripts } from './shell-integration';

/** Runtime classification from the AgentService; `undefined` removes a field. */
export interface TerminalRuntimePatch {
  kind?: TerminalKind;
  foreground?: TerminalInfo['foreground'] | undefined;
  agent?: AgentInfo | undefined;
}

export interface ProjectContext {
  rootPath: string;
  env?: EnvLayer;
  /** Project setting: profile for terminals created without an explicit profile. */
  defaultProfileId?: string;
}

export interface TerminalServiceDeps {
  ptyHost: Pick<UtilityHost<PtyHostMethods, PtyHostEvents>, 'call' | 'onEvent' | 'onDidBecomeReady'>;
  profiles: ProfileService;
  settings: () => Settings;
  resolveProject: (projectId: string) => ProjectContext | null;
  baseEnv: () => EnvLayer | Promise<EnvLayer>;
  /** Reads the scrollback snapshot saved for a panel at the last quit (already wrapped with a separator). */
  readScrollback?: (projectId: string, panelId: string) => Promise<string | null>;
  /** Environment contributions from plugins (M5); applied after project env. */
  pluginEnv?: (ctx: { projectId: string; profileId: string }) => EnvLayer[];
  /** Installed shell integration scripts (M7-T5); null when unavailable. */
  shellIntegration?: () => Promise<ShellIntegrationScripts | null>;
  /** Awaited before spawning (plugin environments at start-up, max 2 s). */
  beforeSpawn?: () => Promise<void>;
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
  private readonly outputEmitter = new Emitter<{ id: string; data: string }>();
  /** Output of terminals watched through `watchOutput`. */
  readonly onDidOutput = this.outputEmitter.event;
  /** Output watchers per terminal (e.g. `plugin:<id>`); the PTY Host emits output while a set is non-empty. */
  private readonly outputWatchers = new Map<string, Set<string>>();

  constructor(private readonly deps: TerminalServiceDeps) {
    const pty = deps.ptyHost;
    this.store.add(pty.onEvent('terminal:exit', (e) => this.patch(e.id, { state: 'exited', exitCode: e.exitCode })));
    this.store.add(pty.onEvent('terminal:title', (e) => this.patch(e.id, { oscTitle: e.title })));
    this.store.add(pty.onEvent('terminal:bell', (e) => this.patch(e.id, { bell: true })));
    this.store.add(pty.onEvent('terminal:cwd', (e) => this.patch(e.id, { cwd: e.cwd })));
    this.store.add(pty.onEvent('terminal:command', (e) => this.onCommand(e)));
    this.store.add(pty.onEvent('terminal:output', (e) => this.outputEmitter.fire(e)));
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

  /** Shell integration events: running command, last command (exit code, duration). */
  private onCommand(e: PtyHostEvents['terminal:command']): void {
    const current = this.terminals.get(e.id);
    if (!current) return;
    const { command: _running, ...rest } = current;
    if (e.phase === 'prompt') {
      if (current.shellIntegration && !current.command) return;
      this.replace({ ...rest, shellIntegration: true });
    } else if (e.phase === 'start') {
      this.replace({
        ...rest,
        shellIntegration: true,
        command: { startedAt: Date.now(), ...(e.commandLine ? { commandLine: e.commandLine } : {}) },
      });
    } else {
      this.replace({
        ...rest,
        shellIntegration: true,
        lastCommand: {
          ...(e.commandLine ? { commandLine: e.commandLine } : {}),
          ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
          durationMs: e.durationMs ?? 0,
          finishedAt: Date.now(),
        },
      });
    }
  }

  private replace(next: TerminalInfo): void {
    const info = this.withTitle(next);
    this.terminals.set(info.id, info);
    this.updatedEmitter.fire(info);
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

  create(req: CreateTerminalRequest): Promise<TerminalInfo> {
    return this.createWith(req);
  }

  private async createWith(req: CreateTerminalRequest, restoreOverride?: string): Promise<TerminalInfo> {
    const project = this.deps.resolveProject(req.projectId);
    if (!project) throw new OxyError('NOT_FOUND', `Project ${req.projectId} not found`);
    const cwd = req.cwd && (await isDirectory(req.cwd)) ? req.cwd : project.rootPath;
    if (!(await isDirectory(cwd))) throw new OxyError('NOT_FOUND', `Folder not found: ${cwd}`);
    // The project's default profile applies when none was asked for; a profile that no longer exists falls back.
    const profileId = req.profileId ?? project.defaultProfileId;
    const launch = await this.deps.profiles
      .resolveLaunch(profileId, cwd)
      .catch((e: unknown) =>
        !req.profileId && e instanceof OxyError && e.code === 'NOT_FOUND'
          ? this.deps.profiles.resolveLaunch(undefined, cwd)
          : Promise.reject(e instanceof Error ? e : new Error(String(e))),
      );
    await this.deps.beforeSpawn?.();
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
        req.env ?? {},
      ],
    });
    const initialCommand = req.initialCommand ?? (req.skipInitialCommand ? undefined : launch.initialCommand);
    // Shell integration (04 §11): scripts injected into bash/zsh/fish/PowerShell.
    let args = launch.args;
    let spawnEnv = env;
    let shellIntegration = false;
    if (settings['terminal.shellIntegration'] && this.deps.shellIntegration) {
      const scripts = await this.deps.shellIntegration().catch(() => null);
      if (scripts) {
        const injection = injectShellIntegration({
          shellType: launch.shellType,
          args: launch.args,
          env,
          scripts,
          platform: this.deps.platform,
        });
        ({ args, env: spawnEnv, injected: shellIntegration } = injection);
      }
    }
    const restoreData =
      restoreOverride ??
      (req.restoreScrollback && this.deps.readScrollback
        ? await this.deps.readScrollback(req.projectId, req.restoreScrollback.panelId)
        : null);
    const { pid } = await this.deps.ptyHost.call('spawn', {
      id,
      file: launch.file,
      args,
      cwd,
      env: spawnEnv,
      cols: req.cols ?? DEFAULT_COLS,
      rows: req.rows ?? DEFAULT_ROWS,
      scrollback: settings['terminal.scrollback'],
      useConptyDll: settings['terminal.windows.useBundledConpty'],
      ...(restoreData ? { restoreData } : {}),
      ...(initialCommand ? { initialCommand } : {}),
      ...(shellIntegration ? { shellIntegration } : {}),
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
      // A restored agent terminal (no agent command typed) starts as a plain shell.
      kind: launch.profile.kind === 'agent' && initialCommand ? 'agent' : 'shell',
      state: 'running',
      createdAt: Date.now(),
      envStale: false,
      bell: false,
      ...(req.background ? { background: true } : {}),
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
    // The old buffer stays visible above a "Restarted" separator.
    const previous =
      info.state === 'failed'
        ? null
        : await this.deps.ptyHost.call('serialize', { id }).then(
            (s) => s.data,
            () => null,
          );
    await this.close(id);
    const { restoreScrollback: _restore, ...rest } = req ?? {
      projectId: info.projectId,
      profileId: info.profileId,
      cwd: info.cwd,
    };
    return this.createWith(
      {
        ...rest,
        projectId: info.projectId,
        profileId: info.profileId,
        cwd: info.cwd,
        ...(info.userTitle ? { userTitle: info.userTitle } : {}),
      },
      previous ? withSeparator(previous, 'Restarted') : undefined,
    );
  }

  /** A background terminal was shown: from now on it is an ordinary terminal with a panel. */
  markShown(id: string): void {
    const current = this.require(id);
    if (!current.background) return;
    const { background: _b, ...rest } = current;
    const req = this.requests.get(id);
    if (req) {
      const { background: _rb, ...request } = req;
      this.requests.set(id, request);
    }
    this.replace(rest);
  }

  /**
   * Adds or removes an output watcher (`owner` names it, e.g. `plugin:<id>`). The PTY Host emits the terminal's
   * output (`onDidOutput`) while at least one watcher is registered.
   */
  async watchOutput(id: string, owner: string, watch: boolean): Promise<void> {
    const info = this.require(id);
    let owners = this.outputWatchers.get(id);
    const before = (owners?.size ?? 0) > 0;
    if (watch) {
      owners ??= new Set();
      owners.add(owner);
      this.outputWatchers.set(id, owners);
    } else if (owners) {
      owners.delete(owner);
      if (owners.size === 0) this.outputWatchers.delete(id);
    }
    const after = (this.outputWatchers.get(id)?.size ?? 0) > 0;
    if (before !== after && info.state === 'running') await this.deps.ptyHost.call('watchOutput', { id, watch: after });
  }

  /** Drops every output watcher of `owner` (a plugin was unloaded). */
  async unwatchAllOutput(owner: string): Promise<void> {
    for (const id of [...this.outputWatchers.keys()]) {
      if (this.outputWatchers.get(id)?.has(owner) && this.terminals.has(id))
        await this.watchOutput(id, owner, false).catch(() => undefined);
    }
  }

  /** TCP ports the terminal's processes listen on (empty for exited terminals). */
  async listeningPorts(id: string): Promise<number[]> {
    const info = this.require(id);
    if (info.state !== 'running') return [];
    return this.deps.ptyHost.call('listeningPorts', { id });
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

  /** Applies the AgentService's classification; fires an update only when something changed. */
  applyRuntime(id: string, patch: TerminalRuntimePatch): void {
    const current = this.terminals.get(id);
    if (!current) return;
    const next: TerminalInfo = { ...current };
    if (patch.kind) next.kind = patch.kind;
    for (const key of ['foreground', 'agent'] as const) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.terminals.set(id, next);
    this.updatedEmitter.fire(next);
  }

  /** Marks a running terminal whose environment contributions changed after it started (⟳ on its tab). */
  markEnvStale(id: string): void {
    const info = this.terminals.get(id);
    if (info && info.state === 'running' && !info.envStale) this.patch(id, { envStale: true });
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
    this.outputWatchers.delete(id);
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
    this.outputEmitter.dispose();
  }
}
