import { release } from 'node:os';
import { spawn } from 'node-pty';
import { fromMessagePort, type MessagePortLike } from '@shared/rpc/adapters';
import type { PtyHostEvents, PtyHostInboundEvents } from '@shared/rpc/contracts/pty-host';
import { startHostRuntime } from '@shared/rpc/host-runtime';
import { SpawnOptionsSchema } from '@shared/domain/terminal';
import { toDisposable } from '@shared/utils/disposable';
import type { Logger } from '@shared/logging/logger';
import { type RendererPort, TerminalManager } from './terminal-manager';
import { busySampleMs, ProcessMonitor } from './process-monitor';
import { listeningPortsOf } from './ports';

// Utility process entry: the PTY Host (node-pty + headless mirrors).
const parentPort = process.parentPort;

const ref: { emit?: (name: string, payload: unknown) => void } = {};
const logRef: { log?: Logger } = {};

const monitorRef: { poke?: () => void; nudge?: (withinMs: number) => void; commandStarted?: () => void } = {};
const manager = new TerminalManager({
  spawnPty: spawn,
  // Same build number as the renderer's `windowsPty` (main's app info), so mirror and view resize alike.
  ...(process.platform === 'win32' ? { windowsBuild: Number(release().split('.')[2] ?? 0) } : {}),
  onSpawned: () => monitorRef.poke?.(),
  emit: (name, payload) => {
    // A command usually starts with Enter; output resuming after a quiet period also hints at new processes.
    if (name === 'terminal:userInput') monitorRef.nudge?.(300);
    else if (name === 'terminal:activity') monitorRef.nudge?.(busySampleMs());
    else if (name === 'terminal:command' && (payload as { phase: string }).phase === 'start') {
      monitorRef.commandStarted?.();
    }
    ref.emit?.(name, payload);
  },
  logger: {
    error: (m, ...a) => logRef.log?.error(m, ...a),
    warn: (m, ...a) => logRef.log?.warn(m, ...a),
    info: (m, ...a) => logRef.log?.info(m, ...a),
    debug: (m, ...a) => logRef.log?.debug(m, ...a),
  },
});

const { rpc, log } = startHostRuntime<PtyHostEvents, PtyHostInboundEvents>({
  parentPort,
  scope: 'pty',
  pid: process.pid,
  impl: {
    spawn: (o: unknown) => manager.spawn(SpawnOptionsSchema.parse(o)),
    write: (o: { id: string; data: string }) => manager.write(o.id, o.data),
    resize: (o: { id: string; cols: number; rows: number }) => manager.resize(o.id, o.cols, o.rows),
    kill: (o: { id: string; force?: boolean }) => manager.kill(o.id, o.force ?? false),
    dispose: (o: { id: string }) => manager.dispose(o.id),
    list: () => manager.list(),
    serialize: (o: { id: string; scrollback?: number }) => manager.serialize(o.id, o.scrollback),
    setScrollback: (o: { scrollback: number }) => manager.setScrollback(o.scrollback),
    getText: (o: { id: string }) => manager.getText(o.id),
    watchOutput: (o: { id: string; watch: boolean }) => manager.watchOutput(o.id, o.watch),
    listeningPorts: async (o: { id: string }) => {
      const pid = manager.pidOf(o.id);
      return pid === null ? [] : listeningPortsOf(pid);
    },
  },
  onShutdown: () => {
    monitor.stop();
    return manager.shutdown();
  },
  exit: (code) => process.exit(code),
});

ref.emit = (name, payload) => rpc.emit(name as keyof PtyHostEvents, payload as never);
logRef.log = log;

const monitor = new ProcessMonitor({
  terminals: () => manager.monitored(),
  onChange: (update) => rpc.emit('terminal:process', update),
  logger: log,
});
monitorRef.poke = () => monitor.poke();
monitorRef.nudge = (ms) => monitor.nudge(ms);
monitorRef.commandStarted = () => monitor.commandStarted();
monitor.start();

/** Electron's MessagePortMain as a RendererPort. */
function toRendererPort(
  port: MessagePortLike & { on(e: 'close', l: () => void): unknown; close(): void },
): RendererPort {
  const endpoint = fromMessagePort(port);
  return {
    postMessage: (m) => port.postMessage(m),
    onMessage: (listener) => endpoint.onMessage((m) => listener(m)),
    onClose: (listener) => {
      port.on('close', listener);
      return toDisposable(() => (port as unknown as { off(e: 'close', l: () => void): void }).off('close', listener));
    },
    close: () => port.close(),
  };
}

rpc.onEvent('renderer-port', (payload, ports) => {
  const port = ports[0] as (MessagePortLike & { on(e: 'close', l: () => void): unknown; close(): void }) | undefined;
  if (!port) return;
  manager.addConnection(payload.windowId, toRendererPort(port));
});

// A stray rejected promise must not take the host down (for the PTY Host: every terminal). Logged instead;
// uncaught exceptions still end the process, which the supervisor restarts.
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection in the PTY Host', reason));

log.info('PTY Host started');
