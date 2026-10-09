import watcher from '@parcel/watcher';
import { startHostRuntime } from '@shared/rpc/host-runtime';
import type { WorkspaceHostEvents, WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import type { Logger } from '@shared/logging/logger';
import { isGitVersionSupported, parseGitVersion, runGit } from './git/exec';
import { RepoRegistry } from './git/repo-registry';
import * as ensembleGit from './git/ensemble-git';
import * as files from './files/project-files';

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
  emitStatus: (status) => ref.emit?.('git:status', status),
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
  'git:getStatus': ({ projectId }) => registry.get(projectId)?.status ?? null,
  'git:getFileDiff': (req) => registry.fileDiff(req),
  'git:action': ({ projectId, action }) => registry.action(projectId, action),
  'git:branches': ({ projectId }) => registry.branches(projectId),
  'files:list': (o) => files.listDir(o),
  'files:find': (o) => files.findFiles(o),
  'files:stat': (o) => files.statFile(o),
  'files:read': (o) => files.readFileContent(o),
  'files:write': (o) => files.writeFileContent(o),
  'files:create': (o) => files.createEntry(o),
  'files:rename': (o) => files.renameEntry(o),
  'files:trashTarget': (o) => files.trashTarget(o),
  'ensemble:repoInfo': ({ gitPath, cwd }) => ensembleGit.repoInfo(gitPath, cwd),
  'ensemble:addWorktree': (o) => ensembleGit.addWorktree(o),
  'ensemble:removeWorktree': (o) => ensembleGit.removeWorktree(o),
  'ensemble:copyFiles': (o) => ensembleGit.copyLocalFiles(o),
  'ensemble:commitAll': (o) => ensembleGit.commitAll(o),
  'ensemble:changes': (o) => ensembleGit.changes(o),
  'ensemble:fileAt': (o) => ensembleGit.fileAt(o),
  'ensemble:finish': (o) => ensembleGit.finish(o),
  'ensemble:resetTo': (o) => ensembleGit.resetTo(o),
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

// A stray rejected promise must not take the host down (for the PTY Host: every terminal). Logged instead;
// uncaught exceptions still end the process, which the supervisor restarts.
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection in the Workspace Host', reason));

log.info('Workspace Host started');
