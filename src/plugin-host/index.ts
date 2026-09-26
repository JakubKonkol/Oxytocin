import { startHostRuntime } from '@shared/rpc/host-runtime';
import type {
  PluginHostEvents,
  PluginHostInboundEvents,
  PluginHostMethods,
  PluginHostToMainMethods,
} from '@shared/rpc/contracts/plugin-host';
import type { PortRpc, RpcEvents } from '@shared/rpc/port-rpc';
import { PluginRuntime } from './runtime';

// Utility process entry: the Plugin Host (backends of all plugins, docs/plan/07-plugin-engine.md §6).
const parentPort = process.parentPort;

type Impl<M> = {
  [K in keyof M]: M[K] extends (params: infer P) => infer R ? (params: P) => R | Promise<R> : never;
};

const ref: { rpc?: PortRpc<PluginHostToMainMethods, PluginHostEvents & RpcEvents, PluginHostInboundEvents> } = {};

const runtime = new PluginRuntime({
  call: (pluginId, method, params) => {
    if (!ref.rpc) return Promise.reject(new Error('Plugin Host is not connected'));
    return ref.rpc.call('api:call', { pluginId, method, params }, { timeoutMs: 60_000 });
  },
  state: (id, state, error) => ref.rpc?.emit('plugin:state', error ? { id, state, error } : { id, state }),
  busy: (id) => ref.rpc?.emit('plugin:busy', { id }),
  log: (pluginId, level, message) => ref.rpc?.emit('log', { level, scope: `plg:${pluginId}`, message }),
});

const impl: Impl<Omit<PluginHostMethods, 'ping' | 'shutdown'>> = {
  'plugins:load': ({ plugins, settings, env }) => runtime.load(plugins, settings, env),
  'plugins:activateByEvent': ({ event }) => runtime.activateByEvent(event),
  'plugins:deactivate': ({ id }) => runtime.deactivate(id),
  'commands:execute': ({ id, args }) => runtime.executeCommand(id, args),
  'plugins:logs': ({ id }) => runtime.logs(id),
};

const { rpc, log } = startHostRuntime<PluginHostEvents, PluginHostInboundEvents>({
  parentPort,
  scope: 'plugin',
  pid: process.pid,
  impl: impl,
  onShutdown: () => runtime.dispose(),
  exit: (code) => process.exit(code),
});
ref.rpc = rpc;
rpc.onEvent('api:event', ({ name, payload }) => runtime.dispatch(name, payload));

// Errors thrown asynchronously by plugin code: blame the plugin (by stack) instead of crashing the host.
const onUncaught = (error: unknown) => {
  const pluginId = runtime.pluginForError(error);
  if (pluginId) {
    void runtime.fail(pluginId, error);
    return;
  }
  log.error('Uncaught error in the Plugin Host', error);
  process.exit(1);
};
process.on('uncaughtException', onUncaught);
process.on('unhandledRejection', onUncaught);

log.info('Plugin Host started');
