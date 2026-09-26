import { z } from 'zod';

export const RefreshReasonSchema = z.enum(['fs', 'gitdir', 'manual', 'focus', 'periodic', 'initial']);

/** Repository discovery result per project (docs/plan/06-git-changes.md §2). */
export const RepoInfoSchema = z.object({
  projectId: z.string(),
  state: z.enum(['ok', 'not-a-repo', 'git-missing', 'error']),
  error: z.string().optional(),
  toplevel: z.string().optional(),
  hasHead: z.boolean(),
  /** Project folder relative to the toplevel when it is a subfolder of the repository. */
  pathspec: z.string().nullable(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const GitInstallationSchema = z.object({
  path: z.string(),
  version: z.string(),
  supported: z.boolean(),
});
export type GitInstallation = z.infer<typeof GitInstallationSchema>;

/** docs/plan/06-git-changes.md §4.3 */
export const ChangeStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
  'typechange',
]);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;

export const FileChangeSchema = z.object({
  /** Relative to the project root, '/' separators. */
  path: z.string(),
  oldPath: z.string().optional(),
  status: ChangeStatusSchema,
  staged: z.boolean(),
  unstaged: z.boolean(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  binary: z.boolean().optional(),
  submodule: z.boolean().optional(),
  /** Last file-system event for the path ("live" highlight). */
  touchedAt: z.number().optional(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const BranchInfoSchema = z.object({
  head: z.string().nullable(),
  detached: z.boolean(),
  oid: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
});
export type BranchInfo = z.infer<typeof BranchInfoSchema>;

/** docs/plan/06-git-changes.md §4.4 */
export const RepoStatusSchema = z.object({
  projectId: z.string(),
  state: z.enum(['ok', 'not-a-repo', 'git-missing', 'error']),
  error: z.string().optional(),
  toplevel: z.string().optional(),
  branch: BranchInfoSchema.optional(),
  headCommit: z.object({ oid: z.string(), subject: z.string(), date: z.number() }).optional(),
  hasHead: z.boolean(),
  files: z.array(FileChangeSchema),
  totals: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }),
  truncated: z.object({ shown: z.number(), total: z.number() }).optional(),
  computedAt: z.number(),
  durationMs: z.number(),
});
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
