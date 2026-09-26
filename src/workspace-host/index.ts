import watcher from '@parcel/watcher';
import { startHostRuntime } from '@shared/rpc/host-runtime';
import type { WorkspaceHostEvents, WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import type { Logger } from '@shared/logging/logger';
import { isGitVersionSupported, parseGitVersion, runGit } from './git/exec';
import { RepoRegistry } from './git/repo-registry';

// Utility process entry: the Workspace Host (git status, file watchers).
const parentPort = process.parentPort;

const ref: { emit?: <K extends keyof WorkspaceHostEvents>(name: K, payload: WorkspaceHostEvents[K]) => void } = {};
const logRef: { log?: Logger } = {};
const logger: Logger = {
  error: (m, ...a) => logRef.log?.error(m, ...a),
  warn: (m, ...a) => logRef.log?.warn(m, ...a),
  info: (m, ...a) => logRef.log?.info(m, ...a),
  debug: (m, ...a) => logRef.log?.debug(m, ...a),
};

const registry = new RepoRegistry({
  subscribe: (dir, onEvents, opts) => watcher.subscribe(dir, onEvents, opts),
  emitRepo: (info) => ref.emit?.('git:repo', info),
  emitTouched: (e) => ref.emit?.('git:fileTouched', e),
  logger,
});

type Impl<M> = {
  [K in keyof M]: M[K] extends (params: infer P) => infer R ? (params: P) => R | Promise<R> : never;
};

const impl: Impl<Omit<WorkspaceHostMethods, 'ping' | 'shutdown'>> = {
  'git:detect': async ({ gitPath }) => {
    try {
      const r = await runGit(gitPath, ['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
      const v = parseGitVersion(r.stdout.toString('utf8'));
      if (r.code !== 0 || !v) return null;
      return { path: gitPath, version: v.join('.'), supported: isGitVersionSupported(v) };
    } catch {
      return null;
    }
  },
  'git:watch': (req) => registry.watch(req),
  'git:unwatch': ({ projectId }) => registry.unwatch(projectId),
  'git:setActive': ({ projectId }) => registry.setActive(projectId),
  'git:refresh': ({ projectId, reason }) => registry.request(projectId, reason),
};

const { rpc, log } = startHostRuntime<WorkspaceHostEvents>({
  parentPort,
  scope: 'ws',
  pid: process.pid,
  impl: impl,
  onShutdown: () => registry.dispose(),
  exit: (code) => process.exit(code),
});
ref.emit = (name, payload) => rpc.emit(name, payload as never);
logRef.log = log;

log.info('Workspace Host started');
