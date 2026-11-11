import { z } from 'zod';
import { MAX_STEPS } from './plan';

export const MAX_PLAN = 90_000;
export const MAX_VERSIONS = 30;

/**
 * An agent for one role. Without `terminalId` Task opens a fresh session of `launchId` (a clean context for each
 * role); `terminalId` is the role's session once started, or a running session the user chose.
 */
export const RoleSchema = z.object({
  launchId: z.string().startsWith('ai:').max(200),
  /** Kept for tasks saved by Task 0.3: every role without a chosen session opens a fresh one. */
  newSession: z.boolean().optional(),
  terminalId: z.string().min(1).max(64).optional(),
});
export const ROLES = ['planner', 'implementer', 'reviewer'] as const;
export type RoleName = (typeof ROLES)[number];
export const TaskInputSchema = z.object({
  description: z.string().trim().min(1).max(8000),
  planner: RoleSchema,
  implementer: RoleSchema,
  reviewer: RoleSchema.optional(),
});
/**
 * One version of the plan. `pending` awaits the user's decision; `revised` got feedback (the planner works on the
 * next version); `superseded` was replaced by a newer version without feedback.
 */
export const PlanVersionSchema = z.object({
  plan: z.string().max(MAX_PLAN),
  at: z.number(),
  /** `capture` (the planner's plan file), `edit` (changed in Task); `hook` in tasks saved by Task 0.4. */
  origin: z.enum(['hook', 'capture', 'edit']),
  source: z.string().max(4096).optional(),
  status: z.enum(['pending', 'revised', 'superseded', 'approved', 'rejected']),
  feedback: z.string().max(8000).optional(),
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;
/**
 * A prompt Task types into a role's existing session as soon as its agent waits for input (it is never typed over
 * a running turn or a question on screen). New sessions get their prompt on the command line instead.
 */
export const OutboxSchema = z.object({
  role: z.enum(ROLES),
  prompt: z
    .string()
    .min(1)
    .max(MAX_PLAN + 9000),
  at: z.number(),
  /** Why it has not been delivered yet (the agent is busy, a question is open…). */
  waiting: z.string().max(500).optional(),
});
export type Outbox = z.infer<typeof OutboxSchema>;
export const TaskSchema = TaskInputSchema.extend({
  id: z.uuid(),
  projectId: z.string().min(1).max(64),
  phase: z.enum(['planning', 'ready', 'implementing', 'reviewing', 'done', 'rejected']),
  plan: z.string().max(MAX_PLAN).default(''),
  versions: z.array(PlanVersionSchema).max(MAX_VERSIONS).default([]),
  approvedPlan: z.string().max(MAX_PLAN).optional(),
  approvedAt: z.number().optional(),
  /** The steps and checks the implementer ticked in the plan file (kept after the file is removed). */
  progress: z
    .object({ steps: z.array(z.boolean()).max(MAX_STEPS), checks: z.array(z.boolean()).max(MAX_STEPS) })
    .optional(),
  outbox: OutboxSchema.optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  source: z.string().optional(),
  error: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskInputSchema>;
export type Role = z.infer<typeof RoleSchema>;

/** Records a new version of the plan; the pending one before it is superseded. */
export function addVersion(
  task: Task,
  version: Omit<PlanVersion, 'status'>,
  status: PlanVersion['status'] = 'pending',
) {
  for (const v of task.versions) if (v.status === 'pending') v.status = 'superseded';
  task.versions.push({ ...version, status });
  // The oldest versions go first; the approved one is kept.
  while (task.versions.length > MAX_VERSIONS) {
    const index = task.versions.findIndex((v) => v.status !== 'approved');
    task.versions.splice(index === -1 ? 0 : index, 1);
  }
  task.plan = version.plan;
  if (version.source) task.source = version.source;
}

/**
 * The files of a task, in the project's `.oxy/tasks` folder (ignored by Git, removed when the task is closed):
 * the task as the user wrote it, the planner's plan, and the instructions ("skills") each role follows.
 */
export interface TaskFiles {
  /** `.oxy/tasks/<id>` */
  dir: string;
  /** `raw.task.json` */
  task: string;
  /** `plan.md` */
  plan: string;
  skills: Record<RoleName, string>;
}

/** `raw.task.json`: what the planner reads. */
export function rawTask(task: Pick<Task, 'id' | 'description' | 'startedAt'>): string {
  const raw = {
    version: 1,
    id: task.id,
    createdAt: new Date(task.startedAt).toISOString(),
    description: task.description,
  };
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/** `path` as the prompts spell it: in backticks, which no shell expands inside a quoted argument. */
const file = (path: string) => `\`${path}\``;

/**
 * Every prompt is one line that only names files, so that a new session receives it on its command line and no
 * agent gets the task, the plan or the rules twice: how to work is in the role's skill file.
 */
export function plannerPrompt(files: TaskFiles): string {
  return `Plan a task for Oxytocin; do not implement it. Follow the instructions in ${file(files.skills.planner)}: the task is in ${file(files.task)}, write the plan to ${file(files.plan)}.`;
}

/** The user's feedback, typed into the planner's session. */
export function revisionPrompt(feedback: string, files: TaskFiles): string {
  return `The user reviewed your plan and asks for changes. Rewrite the whole plan in ${file(files.plan)} in the same format (${file(files.skills.planner)}); do not implement it. Feedback: ${feedback}`;
}

export function implementationPrompt(task: Task, files: TaskFiles): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a non-empty plan first.');
  return `Implement the user-approved plan in ${file(files.plan)}. Follow the instructions in ${file(files.skills.implementer)}.`;
}

export function reviewPrompt(task: Task, files: TaskFiles): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a plan first.');
  return `Review the current changes in this repository against the user-approved plan in ${file(files.plan)}. Follow the instructions in ${file(files.skills.reviewer)}. Do not edit files.`;
}
