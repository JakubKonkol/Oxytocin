import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { RepoStatus } from '@shared/domain/git';
import type { PluginDescriptor } from '@shared/domain/plugin';
import type { Project } from '@shared/domain/project';
import type { Settings } from '@shared/domain/settings';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { OpenViewRequest, PluginLogEntry, ViewEnvelope } from '@shared/rpc/contracts/plugin-host';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import type { EnvContribution, PluginHostService, StatusBarItemState } from './plugin-host-service';
import type { PluginService } from './plugin-service';

/** Built-in plugins run in the main Plugin Host; user and developer plugins in the external one (ADR-022). */
export const runsInBuiltinHost = (p: Pick<PluginDescriptor, 'source'>): boolean => p.source === 'builtin';

/** The plugin set one host serves. */
export function scopedPlugins(
  plugins: Pick<PluginService, 'enabled' | 'get' | 'onDidChange' | 'setRuntimeState'>,
  builtin: boolean,
): Pick<PluginService, 'enabled' | 'get' | 'onDidChange' | 'setRuntimeState'> {
  const inScope = (p: PluginDescriptor) => runsInBuiltinHost(p) === builtin;
  return {
    enabled: () => plugins.enabled().filter(inScope),
    get: (id) => {
      const p = plugins.get(id);
      return p && inScope(p) ? p : undefined;
    },
    onDidChange: plugins.onDidChange,
    setRuntimeState: (id, state, error) => plugins.setRuntimeState(id, state, error),
  };
}

type HostService = Pick<
  PluginHostService,
  | 'reload'
  | 'reloadPlugin'
  | 'activateByEvent'
  | 'executeCommand'
  | 'logs'
  | 'envBarrier'
  | 'viewOpened'
  | 'viewClosed'
  | 'viewVisibility'
  | 'viewMessage'
  | 'hasView'
  | 'notifyProjects'
  | 'notifyActiveProject'
  | 'notifyTerminal'
  | 'notifyTerminalRemoved'
  | 'notifyTerminalOutput'
  | 'notifyAgents'
  | 'notifyGitStatus'
  | 'notifySettings'
  | 'statusBarItems'
  | 'environments'
  | 'onDidChangeStatusBar'
  | 'onDidChangeEnvironment'
>;

/**
 * One plugin engine over two Plugin Hosts: requests go to the host of the plugin they concern, core events go to
 * both, status bar items and terminal environments are merged.
 */
export class PluginHosts implements Disposable {
  private readonly store = new DisposableStore();
  private readonly statusEmitter = new Emitter<StatusBarItemState[]>();
  readonly onDidChangeStatusBar = this.statusEmitter.event;
  private readonly envEmitter = new Emitter<EnvContribution[]>();
  readonly onDidChangeEnvironment = this.envEmitter.event;

  constructor(
    private readonly builtin: HostService,
    private readonly external: HostService,
    private readonly plugins: Pick<PluginService, 'get' | 'list'>,
  ) {
    for (const host of this.all()) {
      this.store.add(host.onDidChangeStatusBar(() => this.statusEmitter.fire(this.statusBarItems())));
      this.store.add(host.onDidChangeEnvironment(() => this.envEmitter.fire(this.environments())));
    }
  }

  private all(): HostService[] {
    return [this.builtin, this.external];
  }

  private forPlugin(id: string): HostService {
    const p = this.plugins.get(id);
    return !p || runsInBuiltinHost(p) ? this.builtin : this.external;
  }

  private forView(viewId: string): HostService | undefined {
    return this.all().find((h) => h.hasView(viewId));
  }

  statusBarItems(): StatusBarItemState[] {
    return this.all().flatMap((h) => [...h.statusBarItems.values()]);
  }

  environments(): EnvContribution[] {
    return this.all().flatMap((h) => [...h.environments.values()]);
  }

  async reload(): Promise<void> {
    await Promise.all(this.all().map((h) => h.reload()));
  }

  reloadPlugin(id: string): Promise<void> {
    return this.forPlugin(id).reloadPlugin(id);
  }

  async activateByEvent(event: string): Promise<string[]> {
    return (await Promise.all(this.all().map((h) => h.activateByEvent(event)))).flat();
  }

  executeCommand(id: string, args: unknown[]): Promise<unknown> {
    const owner = this.plugins.list().find((p) => p.manifest?.contributes.commands.some((c) => c.id === id));
    return (owner ? this.forPlugin(owner.id) : this.builtin).executeCommand(id, args);
  }

  logs(id: string): Promise<PluginLogEntry[]> {
    return this.forPlugin(id).logs(id);
  }

  async envBarrier(): Promise<void> {
    await Promise.all(this.all().map((h) => h.envBarrier()));
  }

  viewOpened(req: OpenViewRequest): Promise<void> {
    return this.forPlugin(req.pluginId).viewOpened(req);
  }

  async viewClosed(viewId: string): Promise<void> {
    await this.forView(viewId)?.viewClosed(viewId);
  }

  async viewVisibility(viewId: string, visible: boolean): Promise<void> {
    await this.forView(viewId)?.viewVisibility(viewId, visible);
  }

  viewMessage(viewId: string, envelope: ViewEnvelope): Promise<void> {
    // Unknown views are rejected by the service ("not open").
    return (this.forView(viewId) ?? this.builtin).viewMessage(viewId, envelope);
  }

  notifyProjects(projects: Project[]): void {
    for (const h of this.all()) h.notifyProjects(projects);
  }

  notifyActiveProject(id: string | null): void {
    for (const h of this.all()) h.notifyActiveProject(id);
  }

  notifyTerminal(info: TerminalInfo): void {
    for (const h of this.all()) h.notifyTerminal(info);
  }

  notifyTerminalRemoved(id: string): void {
    for (const h of this.all()) h.notifyTerminalRemoved(id);
  }

  notifyTerminalOutput(id: string, data: string): void {
    for (const h of this.all()) h.notifyTerminalOutput(id, data);
  }

  notifyAgents(list: AgentInfoWithTerminal[]): void {
    for (const h of this.all()) h.notifyAgents(list);
  }

  notifyGitStatus(status: RepoStatus): void {
    for (const h of this.all()) h.notifyGitStatus(status);
  }

  notifySettings(settings: Settings): void {
    for (const h of this.all()) h.notifySettings(settings);
  }

  dispose(): void {
    this.store.dispose();
    this.statusEmitter.dispose();
    this.envEmitter.dispose();
  }
}
