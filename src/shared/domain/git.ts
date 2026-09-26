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
