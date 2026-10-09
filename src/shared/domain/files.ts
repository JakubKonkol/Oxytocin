import { z } from 'zod';
import { ProjectIdSchema } from './terminal';

/** A project-relative path ('/' separators, no `..`); '' is the project folder itself. */
export const ProjectPathSchema = z
  .string()
  .max(4096)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !/^[a-zA-Z]:/.test(p), 'Expected a relative path')
  .refine((p) => p === '' || p.split('/').every((s) => s !== '' && s !== '..' && s !== '.'), 'Invalid path');

export const FileEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  /** Ignored by git (.gitignore): shown dimmed. */
  ignored: z.boolean().optional(),
  symlink: z.boolean().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  /** Text content (null for binaries and files above the size limit). */
  content: z.string().nullable(),
  languageId: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  binary: z.boolean().optional(),
  tooLarge: z.boolean().optional(),
  /** The file starts with a UTF-8 byte order mark (kept when saving). */
  bom: z.boolean().optional(),
  eol: z.enum(['crlf', 'lf', 'mixed']).optional(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const FileStatSchema = z.object({ mtimeMs: z.number(), size: z.number(), isFile: z.boolean() });
export type FileStat = z.infer<typeof FileStatSchema>;

export const FileWriteRequestSchema = z.object({
  projectId: ProjectIdSchema,
  path: ProjectPathSchema.refine((p) => p !== '', 'Expected a file'),
  content: z.string().max(100_000_000),
  bom: z.boolean().optional(),
  /** Modification time of the version the edit started from: a newer file on disk is a conflict. */
  expectedMtimeMs: z.number().optional(),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;

export const FileListSchema = z.object({
  files: z.array(z.string()),
  /** More files than the limit: the list is cut. */
  truncated: z.boolean(),
});
export type FileList = z.infer<typeof FileListSchema>;
