import { z } from 'zod';

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
  planMode: z.boolean().default(true),
});
/**
 * One version of the plan. `pending` awaits the user's decision; `revised` got feedback (the planner works on the
 * next version); `superseded` was replaced by a newer version without feedback.
 */
export const PlanVersionSchema = z.object({
  plan: z.string().max(MAX_PLAN),
  at: z.number(),
  /** `hook` (Claude Code finished the plan), `capture` (a plan document), `edit` (changed in Task). */
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
  /** The planner terminal that Task started with its plan hook (plans arrive from Claude Code, not from files). */
  hookTerminalId: z.string().max(64).optional(),
  approvedPlan: z.string().max(MAX_PLAN).optional(),
  approvedAt: z.number().optional(),
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
 * The files Task gives the agents (in its own storage, outside the repository): the description, the plan document
 * of a planner that is not Claude Code, and the brief that the implementer and the reviewer read.
 */
export interface TaskFiles {
  task: string;
  plan: string;
  brief: string;
}

/** `path` as the prompts spell it: in backticks, which no shell expands inside a quoted argument. */
const file = (path: string) => `\`${path}\``;

/** The description itself when it reads well in the prompt's single line, else only the file holding it. */
function taskLine(task: Task, files: TaskFiles): string {
  const d = task.description.trim();
  return /^[^\n\r\t%!`]{1,400}$/.test(d)
    ? `Task: ${d} (also saved in ${file(files.task)}).`
    : `The task is described in ${file(files.task)}; read it first.`;
}

/**
 * The planner's first prompt: one line, so that a new session receives it on its command line. `hooked`: a Claude
 * Code session started with Task's plan hook.
 */
export function plannerPrompt(task: Task, files: TaskFiles, hooked: boolean): string {
  const common = `Plan this task; do not implement it. ${taskLine(task, files)} Explore the code and ask the user in this terminal when something is unclear.`;
  if (hooked)
    return `${common} When the plan is complete, finish it with ExitPlanMode: Oxytocin shows it to the user for approval and a separate agent implements it.`;
  return `${common} ${task.planMode ? 'Use plan mode if you have one. ' : ''}Write the final plan as a Markdown document to ${file(files.plan)} (Claude Code may use its native plan document instead; Oxytocin captures it), then stop: the user approves the plan in Oxytocin and a separate agent implements it.`;
}

/** The user's feedback typed into a planner whose plan hook no longer waits (or that has none). */
export function revisionPrompt(feedback: string, files: TaskFiles, hooked: boolean): string {
  if (hooked)
    return `The user reviewed your plan and asks for changes. Revise it in plan mode and finish the whole revised plan with ExitPlanMode again. Feedback: ${feedback}`;
  return `The user reviewed your plan and asks for changes. Revise it and write the whole revised Markdown plan to ${file(files.plan)} again (Claude Code: your native plan document). Do not implement it. Feedback: ${feedback}`;
}

/** The brief the implementer and the reviewer read: the task and the approved plan, nothing from the planner's chat. */
export function briefDocument(task: Task): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a non-empty plan first.');
  return `# Task\n\n${task.description.trim()}\n\n# Approved plan\n\n${task.approvedPlan.trim()}\n`;
}

export function implementationPrompt(task: Task, files: TaskFiles): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a non-empty plan first.');
  return `Implement the user-approved plan in ${file(files.brief)}. Read the whole file first; it holds the task and the plan, which was written and approved before you started. Follow the project's instructions and run the relevant checks.`;
}

export function reviewPrompt(task: Task, files: TaskFiles): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a plan first.');
  return `Review the current changes in this repository against the task and the user-approved plan in ${file(files.brief)} (read it first). Check for bugs, regressions and missing requirements. Report actionable findings as a concise list with file and line references. Do not edit files.`;
}
