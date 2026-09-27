import { relative, resolve, sep } from 'node:path';
import { runGit } from './exec';

export type RepoInfo =
  | { state: 'not-a-repo' }
  | {
      state: 'ok';
      /** Worktree root. */
      toplevel: string;
      gitDir: string;
      commonDir: string;
      isBare: boolean;
      hasHead: boolean;
      /** Project root relative to the toplevel ('/' separators) when the project is a subfolder (monorepo). */
      pathspec: string | null;
    };

/** `rev-parse` in the project root. */
export async function discoverRepo(gitPath: string, rootPath: string): Promise<RepoInfo> {
  const r = await runGit(
    gitPath,
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--is-bare-repository'],
    { cwd: rootPath, timeoutMs: 10_000 },
  );
  if (r.code !== 0) return { state: 'not-a-repo' };
  const [toplevelRaw, gitDir, commonDirRaw, bare] = r.stdout.toString('utf8').trim().split(/\r?\n/);
  if (!toplevelRaw || !gitDir || !commonDirRaw) return { state: 'not-a-repo' };
  const toplevel = resolve(toplevelRaw);
  const head = await runGit(gitPath, ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: rootPath, timeoutMs: 10_000 });
  const rel = relative(toplevel, resolve(rootPath));
  return {
    state: 'ok',
    toplevel,
    gitDir: resolve(gitDir),
    commonDir: resolve(rootPath, commonDirRaw),
    isBare: bare === 'true',
    hasHead: head.code === 0,
    pathspec: rel && !rel.startsWith('..') ? rel.split(sep).join('/') : null,
  };
}
