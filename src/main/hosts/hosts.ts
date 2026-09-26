import { utilityProcess } from 'electron';
import type { PluginHostEvents, PluginHostMethods } from '@shared/rpc/contracts/plugin-host';
import type { PtyHostEvents, PtyHostMethods } from '@shared/rpc/contracts/pty-host';
import type { WorkspaceHostEvents, WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import type { HostStatus } from '@shared/domain/app-info';
import type { Logger } from '@shared/logging/logger';
import { Emitter } from '@shared/utils/emitter';
import { appPaths } from '../app/paths';
import { writeForwardedLog } from '../logging/log';
import { type HostProcess, UtilityHost } from './utility-host';

type HostEntry = 'ptyHost' | 'workspaceHost' | 'pluginHost';

const INSPECT_PORTS: Record<HostEntry, number> = { ptyHost: 9230, workspaceHost: 9231, pluginHost: 9232 };

function forkHost(entry: HostEntry, serviceName: string, logger: Logger, env: NodeJS.ProcessEnv): HostProcess {
  const execArgv = process.env['OXYTOCIN_INSPECT_HOSTS'] === '1' ? [`--inspect=${INSPECT_PORTS[entry]}`] : [];
  const child = utilityProcess.fork(appPaths.hostEntry(entry), [], { serviceName, stdio: 'pipe', env, execArgv });
  child.stdout?.on('data', (chunk: Buffer) => logger.info(chunk.toString().trimEnd()));
  child.stderr?.on('data', (chunk: Buffer) => logger.warn(chunk.toString().trimEnd()));
  return child;
}

/** The three utility processes (docs/plan/01-architecture.md §2). */
export class Hosts {
  readonly pty: UtilityHost<PtyHostMethods, PtyHostEvents>;
  readonly workspace: UtilityHost<WorkspaceHostMethods, WorkspaceHostEvents>;
  readonly plugin: UtilityHost<PluginHostMethods, PluginHostEvents>;
  private readonly statusEmitter = new Emitter<HostStatus[]>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(createLogger: (scope: string) => Logger, env: () => NodeJS.ProcessEnv) {
    const make = <M extends PtyHostMethods, E extends PtyHostEvents>(
      entry: HostEntry,
      serviceName: string,
      scope: string,
    ) => {
      const logger = createLogger(scope);
      const host = new UtilityHost<M, E>({
        name: serviceName,
        logger: createLogger('hosts'),
        onLog: writeForwardedLog,
        spawn: () => forkHost(entry, serviceName, logger, env()),
      });
      host.onDidChangeState(() => this.statusEmitter.fire(this.status()));
      return host;
    };
    this.pty = make('ptyHost', 'Oxytocin PTY Host', 'pty');
    this.workspace = make('workspaceHost', 'Oxytocin Workspace Host', 'ws');
    this.plugin = make('pluginHost', 'Oxytocin Plugin Host', 'plg');
  }

  all(): UtilityHost<PtyHostMethods, PtyHostEvents>[] {
    return [this.pty, this.workspace, this.plugin];
  }

  status(): HostStatus[] {
    return this.all().map((h) => h.status);
  }

  startAll(): void {
    for (const host of this.all()) host.start();
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.all().map((h) => h.stop()));
  }
}
