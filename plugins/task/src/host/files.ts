import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_PLAN, rawTask, ROLES, type RoleName, type Task, type TaskFiles } from '../shared/task';
import { SKILLS } from './skills';

/** Everything Task writes into a project lives here; the folder ignores itself in Git. */
const tasksRoot = (projectRoot: string) => join(projectRoot, '.oxy', 'tasks');
const SKILLS_DIR = 'skills';
const GITIGNORE = '.gitignore';

export function taskFiles(projectRoot: string, taskId: string): TaskFiles {
  const root = tasksRoot(projectRoot);
  const dir = join(root, taskId);
  return {
    dir,
    task: join(dir, 'raw.task.json'),
    plan: join(dir, 'plan.md'),
    skills: Object.fromEntries(ROLES.map((role) => [role, join(root, SKILLS_DIR, SKILLS[role].file)])) as Record<
      RoleName,
      string
    >,
  };
}

/** Writes a file unless it already has this content (an agent may be reading it). */
async function ensureFile(path: string, text: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== text) await writeFile(path, text);
}

/**
 * Makes sure the task's folder, its `raw.task.json`, the skills and the `.gitignore` exist and are current. Called
 * before every prompt, so a folder that was removed by hand (or belongs to a task saved by an older Task) comes back.
 * `plan` is the plan the role reads: `replace` writes exactly what the user approved; otherwise an existing file is
 * kept, with the implementer's ticks.
 */
export async function prepareTaskFiles(
  projectRoot: string,
  task: Task,
  plan?: { text: string; replace: boolean },
): Promise<TaskFiles> {
  const files = taskFiles(projectRoot, task.id);
  const root = tasksRoot(projectRoot);
  await mkdir(files.dir, { recursive: true });
  await mkdir(join(root, SKILLS_DIR), { recursive: true });
  await ensureFile(join(root, GITIGNORE), '*\n');
  for (const role of ROLES) await ensureFile(files.skills[role], SKILLS[role].text);
  await ensureFile(files.task, rawTask(task));
  const current = plan ? await readFile(files.plan, 'utf8').catch(() => '') : '';
  if (plan?.text.trim() && (plan.replace ? current.trim() !== plan.text.trim() : !current.trim()))
    await writeFile(files.plan, `${plan.text.trim()}\n`);
  return files;
}

/** The plan file when it has a plan of an acceptable size; `tooLarge` instead of a plan beyond `MAX_PLAN`. */
export async function readPlanFile(
  path: string,
): Promise<{ text: string; mtimeMs: number } | { tooLarge: true } | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > MAX_PLAN * 4) return { tooLarge: true };
  const text = await readFile(path, 'utf8').catch(() => '');
  if (!text.trim()) return null;
  return text.length > MAX_PLAN ? { tooLarge: true } : { text, mtimeMs: info.mtimeMs };
}

/**
 * Removes a closed task's folder. The shared files go with the last task, and `.oxy` itself only when nothing else
 * (a Code Map, learnings) is in it.
 */
export async function removeTaskFiles(projectRoot: string, taskId: string): Promise<void> {
  const root = tasksRoot(projectRoot);
  await rm(join(root, taskId), { recursive: true, force: true, maxRetries: 3 });
  const left = await readdir(root).catch(() => null);
  if (!left || left.some((entry) => entry !== SKILLS_DIR && entry !== GITIGNORE)) return;
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
  await rmdir(join(projectRoot, '.oxy')).catch(() => undefined);
}

/**
 * A path as Claude Code's permission rules spell an absolute path: `//` + the POSIX form (Windows drive paths are
 * normalized to `/c/Users/...` before matching).
 */
export function absoluteRulePath(path: string): string {
  const windows = /^([A-Za-z]):[\\/]*(.*)$/.exec(path);
  const posix = windows ? `/${windows[1]!.toLowerCase()}/${windows[2]!.replace(/\\/g, '/')}` : path;
  return `/${posix.replace(/\/+$/, '')}`;
}

/**
 * The `--settings` file of a Claude Code session started by Task (it only adds to the user's and the project's
 * settings): reading Task's folder asks no permission, and neither does writing the task's own folder for the roles
 * that write there (the planner its plan, the implementer its ticks). Nothing else is allowed or denied.
 */
export function claudeSettings(projectRoot: string, files: TaskFiles, role: RoleName) {
  const read = `Read(${absoluteRulePath(tasksRoot(projectRoot))}/**)`;
  const write = `Edit(${absoluteRulePath(files.dir)}/**)`;
  return { permissions: { allow: role === 'reviewer' ? [read] : [read, write] } };
}
