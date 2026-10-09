import { z } from 'zod';

export const RefreshReasonSchema = z.enum(['fs', 'gitdir', 'manual', 'focus', 'periodic', 'initial']);

/** Repository discovery result per project. */
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

export const FileDiffContentSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: ChangeStatusSchema,
  /** HEAD version (null for added/untracked files or without HEAD). */
  original: z.string().nullable(),
  /** Version on disk (null for deleted files). */
  modified: z.string().nullable(),
  languageId: z.string(),
  binary: z.boolean().optional(),
  tooLarge: z.object({ sizeBytes: z.number() }).optional(),
  eol: z.enum(['crlf', 'lf', 'mixed']).optional(),
  /** Sizes for binaries / too large files. */
  sizes: z.object({ original: z.number().nullable(), modified: z.number().nullable() }).optional(),
  /** Modification time of the file on disk (saving an edit checks it did not change meanwhile). */
  mtimeMs: z.number().optional(),
  /** The file on disk starts with a UTF-8 byte order mark. */
  bom: z.boolean().optional(),
});
export type FileDiffContent = z.infer<typeof FileDiffContentSchema>;

export const FileDiffRequestSchema = z.object({
  projectId: z.string(),
  path: z.string().min(1),
  oldPath: z.string().optional(),
});
export type FileDiffRequest = z.infer<typeof FileDiffRequestSchema>;

/** Paths of a git action: project-relative, '/' separators. */
const ActionPathsSchema = z.array(z.string().min(1).max(4096)).min(1).max(5000);

/** A branch name; never an option (`-x`). git checks the rest (`check-ref-format`). */
const BranchNameSchema = z
  .string()
  .min(1)
  .max(250)
  .refine((n) => !n.startsWith('-'), 'Invalid branch name');

/** Something the user does to the repository from the CHANGES section, a diff or the review. */
export const GitActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage'), paths: ActionPathsSchema }),
  z.object({ kind: z.literal('unstage'), paths: ActionPathsSchema }),
  z.object({ kind: z.literal('stageAll') }),
  z.object({ kind: z.literal('unstageAll') }),
  /** Back to HEAD: tracked files are restored, new files deleted. */
  z.object({ kind: z.literal('discard'), paths: ActionPathsSchema }),
  z.object({ kind: z.literal('discardAll') }),
  z.object({
    kind: z.literal('commit'),
    message: z.string().max(100_000),
    amend: z.boolean().optional(),
    /** Stage every change of the project first (nothing was staged). */
    stageAll: z.boolean().optional(),
  }),
  /** `git reset --soft HEAD~1`: the last commit's changes go back to the staging area. */
  z.object({ kind: z.literal('undoCommit') }),
  z.object({ kind: z.literal('push') }),
  z.object({ kind: z.literal('pull') }),
  z.object({ kind: z.literal('fetch') }),
  z.object({ kind: z.literal('stash'), message: z.string().max(500).optional() }),
  z.object({ kind: z.literal('stashPop') }),
  z.object({ kind: z.literal('checkout'), branch: BranchNameSchema }),
  z.object({ kind: z.literal('createBranch'), name: BranchNameSchema }),
]);
export type GitAction = z.infer<typeof GitActionSchema>;
export type GitActionKind = GitAction['kind'];

export const GitActionResultSchema = z.object({
  /** What git printed (trimmed), e.g. the summary of a push. */
  output: z.string(),
  /** The new commit of `commit`. */
  commit: z.string().optional(),
});
export type GitActionResult = z.infer<typeof GitActionResultSchema>;

export const BranchListSchema = z.object({
  current: z.string().nullable(),
  local: z.array(z.object({ name: z.string(), upstream: z.string().optional(), date: z.number() })),
  remotes: z.array(z.string()),
  stashes: z.number(),
});
export type BranchList = z.infer<typeof BranchListSchema>;
