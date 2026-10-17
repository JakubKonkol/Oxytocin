import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

const MAX_PLAN_BYTES = 90_000;
const RowSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(200)
    .optional(),
  message: z.object({ content: z.unknown() }).optional(),
});
const ToolSchema = z.object({
  type: z.literal('tool_use'),
  name: z.string(),
  input: z.object({ file_path: z.string() }),
});

/** Only document references are extracted. Conversation and tool output never enter another agent's context. */
export function planReferences(transcript: string): { slug?: string; paths: string[] } {
  let slug: string | undefined;
  const paths: string[] = [];
  for (const line of transcript.split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const row = RowSchema.safeParse(raw);
    if (!row.success) continue;
    if (row.data.slug) slug = row.data.slug;
    const content = row.data.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const tool = ToolSchema.safeParse(block);
      if (tool.success && ['Write', 'Edit', 'Read'].includes(tool.data.name)) paths.push(tool.data.input.file_path);
    }
  }
  return { ...(slug ? { slug } : {}), paths };
}

export async function readPlan(path: string, since: number): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.mtimeMs < since || info.size > MAX_PLAN_BYTES) return null;
  const text = await readFile(path, 'utf8');
  return text.trim() ? text : null;
}

/** Read only the recent transcript tail, never recursively read conversation contents. */
export async function captureClaudePlan(
  home: string,
  sessionId: string,
  since: number,
): Promise<{ path: string; text: string } | null> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return null;
  const projects = join(home, 'projects');
  const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = join(projects, dir.name, `${sessionId}.jsonl`);
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) continue;
    let transcript: string;
    try {
      const info = await handle.stat();
      const start = Math.max(0, info.size - 512 * 1024);
      const buffer = Buffer.alloc(Math.min(info.size, 512 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      transcript = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const refs = planReferences(transcript);
    const root = await realpath(join(home, 'plans')).catch(() => null);
    if (!root) return null;
    const candidates = [...refs.paths.reverse(), ...(refs.slug ? [join(root, `${refs.slug}.md`)] : [])];
    for (const candidate of candidates) {
      const path = await realpath(candidate).catch(() => null);
      if (!path || !basename(path).endsWith('.md')) continue;
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue;
      const text = await readPlan(path, since);
      if (text) return { path, text };
    }
  }
  return null;
}
