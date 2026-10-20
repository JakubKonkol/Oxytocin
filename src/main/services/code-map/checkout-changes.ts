import { CodeMapRefSchema } from '@shared/domain/code-map-plugin';
import { GitCheckoutChangesSchema } from '@shared/domain/git-checkout';
import type { RepoStatus } from '@shared/domain/git';
import type { EnsembleChange } from '@shared/domain/ensemble';
import { OxyError } from '@shared/errors';

/** Resolves only registered identities. Git I/O remains in Workspace Host. */
export async function checkoutChanges(
  input: { projectId: string; checkoutId: string },
  deps: {
    root(projectId: string, checkoutId: string): string;
    status(projectId: string): RepoStatus | null;
    task(id: string): { projectId: string; path?: string; baseCommit?: string } | undefined;
    changes(taskId: string): Promise<EnsembleChange[]>;
  },
) {
  const ref = CodeMapRefSchema.parse(input),
    root = deps.root(ref.projectId, ref.checkoutId);
  let files: { path: string; oldPath?: string; status: string }[], baseCommit: string | undefined;
  let total: number;
  const worktree = ref.checkoutId !== ref.projectId;
  if (worktree) {
    const taskId = ref.checkoutId.slice('worktree:'.length),
      task = deps.task(taskId);
    if (
      !ref.checkoutId.startsWith('worktree:') ||
      task?.projectId !== ref.projectId ||
      task.path !== root ||
      !task.baseCommit
    )
      throw new OxyError('UNAVAILABLE', 'The worktree base is unavailable');
    baseCommit = task.baseCommit;
    files = await deps.changes(taskId);
    const current = deps.task(taskId);
    if (current?.path !== root || current.baseCommit !== baseCommit || current.projectId !== ref.projectId)
      throw new OxyError('UNAVAILABLE', 'The worktree changed during comparison');
    total = files.length;
  } else {
    const status = deps.status(ref.projectId);
    if (!status || status.state !== 'ok')
      throw new OxyError('UNAVAILABLE', 'Git status is unavailable for this checkout');
    files = status.files;
    total = status.truncated?.total ?? files.length;
  }
  if (deps.root(ref.projectId, ref.checkoutId) !== root)
    throw new OxyError('UNAVAILABLE', 'The checkout changed during comparison');
  const available = files.length;
  files = files.filter((file) => !file.path.split('/').includes('.oxy') && !file.oldPath?.split('/').includes('.oxy'));
  total -= available - files.length;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bounded: typeof files = [];
  let bytes = 0;
  for (const { path, oldPath, status } of files) {
    const file = { path, ...(oldPath ? { oldPath } : {}), status };
    bytes += Buffer.byteLength(JSON.stringify(file)) + 1;
    if (bounded.length === 500 || bytes > 512 * 1024 - 4096) break;
    bounded.push(file);
  }
  return GitCheckoutChangesSchema.parse({
    ...ref,
    comparison: worktree ? 'worktree-base' : 'head',
    baseCommit,
    files: bounded,
    total,
    truncated: total > bounded.length,
  });
}
