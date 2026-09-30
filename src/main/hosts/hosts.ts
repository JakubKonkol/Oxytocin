import { utilityProcess } from 'electron';
import type { ConnectionsHostEvents, ConnectionsHostMethods } from '@shared/rpc/contracts/connections-host';
import type { PluginHostEvents, PluginHostMethods } from '@shared/rpc/contracts/plugin-host';
import type { PtyHostEvents, PtyHostMethods } from '@shared/rpc/contracts/pty-host';
import type { WorkspaceHostEvents, WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import type { HostStatus } from '@shared/domain/app-info';
import type { HostBaseEvents, HostBaseMethods } from '@shared/rpc/contracts/host-base';
import type { Logger } from '@shared/logging/logger';
import { Emitter } from '@shared/utils/emitter';
import { appPaths } from '../app/paths';
import { writeForwardedLog } from '../logging/log';
import { type HostProcess, UtilityHost, type UtilityHostOptions } from './utility-host';

/** The lifecycle surface shared by all hosts regardless of their RPC contract. */
export type SupervisedHost = Pick<
  UtilityHost<HostBaseMethods, HostBaseEvents>,
  'status' | 'start' | 'stop' | 'kill' | 'name'
>;

type HostEntry = 'ptyHost' | 'workspaceHost' | 'pluginHost' | 'connectionsHost';

function forkHost(
  entry: HostEntry,
  serviceName: string,
  logger: Logger,
  env: NodeJS.ProcessEnv,
  inspectPort: number,
): HostProcess {
  const execArgv = process.env['OXYTOCIN_INSPECT_HOSTS'] === '1' ? [`--inspect=${inspectPort}`] : [];
  const child = utilityProcess.fork(appPaths.hostEntry(entry), [], { serviceName, stdio: 'pipe', env, execArgv });
  child.stdout?.on('data', (chunk: Buffer) => logger.info(chunk.toString().trimEnd()));
  child.stderr?.on('data', (chunk: Buffer) => logger.warn(chunk.toString().trimEnd()));
  return child;
}

/**
 * The utility processes. Plugins installed by the user or loaded in developer mode
 * run in a second Plugin Host (ADR-022), started on demand by the plugin engine.
 */
export class Hosts {
  readonly pty: UtilityHost<PtyHostMethods, PtyHostEvents>;
  readonly workspace: UtilityHost<WorkspaceHostMethods, WorkspaceHostEvents>;
  readonly plugin: UtilityHost<PluginHostMethods, PluginHostEvents>;
  readonly externalPlugin: UtilityHost<PluginHostMethods, PluginHostEvents>;
  /** Database drivers and API requests of project resources (Plan 02); started on first use. */
  readonly connections: UtilityHost<ConnectionsHostMethods, ConnectionsHostEvents>;
  private readonly statusEmitter = new Emitter<HostStatus[]>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(createLogger: (scope: string) => Logger, env: () => NodeJS.ProcessEnv) {
    const make = <M extends HostBaseMethods, E extends HostBaseEvents>(
      entry: HostEntry,
      serviceName: string,
      scope: string,
      inspectPort: number,
      extra: Partial<UtilityHostOptions> = {},
    ) => {
      const logger = createLogger(scope);
      const host = new UtilityHost<M, E>({
        name: serviceName,
        logger: createLogger('hosts'),
        onLog: writeForwardedLog,
        spawn: () => forkHost(entry, serviceName, logger, env(), inspectPort),
        ...extra,
      });
      host.onDidChangeState(() => this.statusEmitter.fire(this.status()));
      return host;
    };
    this.pty = make<PtyHostMethods, PtyHostEvents>('ptyHost', 'Oxytocin PTY Host', 'pty', 9230);
    this.workspace = make<WorkspaceHostMethods, WorkspaceHostEvents>(
      'workspaceHost',
      'Oxytocin Workspace Host',
      'ws',
      9231,
    );
    // A plugin blocking the event loop must be noticed quickly: ping every 5 s, restart after 15 s of silence.
    const pluginPing = { pingIntervalMs: 5000, maxMissedPings: 3 };
    this.plugin = make<PluginHostMethods, PluginHostEvents>(
      'pluginHost',
      'Oxytocin Plugin Host',
      'plg',
      9232,
      pluginPing,
    );
    this.externalPlugin = make<PluginHostMethods, PluginHostEvents>(
      'pluginHost',
      'Oxytocin Plugin Host (external)',
      'plg-ext',
      9233,
      pluginPing,
    );
    this.connections = make<ConnectionsHostMethods, ConnectionsHostEvents>(
      'connectionsHost',
      'Oxytocin Connections Host',
      'conn',
      9234,
    );
  }

  /** Starts the Connections Host when it is not running (it is only needed once a project has resources). */
  ensureConnections(): void {
    const state = this.connections.state;
    if (state === 'stopped' || state === 'failed') this.connections.start();
  }

  all(): SupervisedHost[] {
    return [this.pty, this.workspace, this.plugin, this.externalPlugin, this.connections];
  }

  status(): HostStatus[] {
    return this.all().map((h) => h.status);
  }

  /** Starts the core hosts; the external Plugin Host starts when a user or developer plugin is enabled. */
  startAll(): void {
    for (const host of [this.pty, this.workspace, this.plugin]) host.start();
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.all().map((h) => h.stop()));
  }
}
