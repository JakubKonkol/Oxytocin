import { createForwardingLogger, type Logger } from '../logging/logger';
import { fromMessagePort, type MessagePortLike } from './adapters';
import type { HostBaseEvents } from './contracts/host-base';
import { createPortRpc, type PortRpc, type RpcEvents, type RpcMethods } from './port-rpc';

export interface HostRuntime<Emits extends RpcEvents, Receives extends RpcEvents> {
  rpc: PortRpc<RpcMethods, Emits & HostBaseEvents, Receives>;
  log: Logger;
}

/**
 * Bootstraps a utility host: serves `impl` (plus `ping`/`shutdown`) over the parent port and forwards
 * logs to main. `onShutdown` runs before the process exits.
 */
export function startHostRuntime<Emits extends RpcEvents = RpcEvents, Receives extends RpcEvents = RpcEvents>(opts: {
  parentPort: MessagePortLike;
  scope: string;
  pid: number;
  impl: Record<string, (params: never) => unknown>;
  onShutdown?: () => Promise<void> | void;
  exit: (code: number) => void;
}): HostRuntime<Emits, Receives> {
  const ref: { rpc?: PortRpc<RpcMethods, Emits & HostBaseEvents, Receives> } = {};
  const log = createForwardingLogger(opts.scope, (record) => ref.rpc?.emit('log', record as never));
  const rpc = createPortRpc<RpcMethods, Emits & HostBaseEvents, Receives>(fromMessagePort(opts.parentPort), {
    ...opts.impl,
    ping: () => 'pong',
    shutdown: async () => {
      try {
        await opts.onShutdown?.();
      } finally {
        // Let the response flush before exiting.
        setTimeout(() => opts.exit(0), 10);
      }
    },
  });
  ref.rpc = rpc;
  rpc.emit('ready', { pid: opts.pid } as never);
  return { rpc, log };
}
