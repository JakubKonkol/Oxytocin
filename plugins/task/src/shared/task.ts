import { z } from 'zod';

export const MAX_PLAN = 90_000;
export const MAX_VERSIONS = 30;

export const RoleSchema = z.object({
  launchId: z.string().startsWith('ai:').max(200),
  newSession: z.boolean().optional(),
  terminalId: z.string().min(1).max(64).optional(),
});
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

export function plannerPrompt(task: Task, document: string, hooked: boolean): string {
  if (hooked)
    return `Plan this task; do not implement it. Explore the code and discuss questions with the user in this terminal. When the plan is complete, finish it with ExitPlanMode: Oxytocin hands it to the user for approval, and a separate agent implements it.\n\nTask:\n${task.description}`;
  return `Plan this task; do not implement it. Discuss questions with the user in this terminal. ${task.planMode ? 'Use plan mode. ' : ''}If you are Claude Code, save the final plan in your native plan document; Oxytocin will capture it. Otherwise save the final Markdown plan to ${JSON.stringify(document)}. Stop after planning: the user approves the plan in Task and a separate agent implements it.\n\nTask:\n${task.description}`;
}

/** The user's feedback for the planner. A hooked Claude session was told how to finish the revision already. */
export function revisionPrompt(feedback: string, document: string, hooked: boolean): string {
  if (hooked) return feedback;
  return `Revise the plan with the feedback below, then save the whole revised Markdown plan again (Claude Code: your native plan document; other agents: ${JSON.stringify(document)}). Do not implement it.\n\nFeedback:\n${feedback}`;
}

export function implementationPrompt(task: Task): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a non-empty plan first.');
  return `Implement the following user-approved plan. Follow the project's instructions and run the relevant checks.\n\nTask:\n${task.description}\n\nApproved plan:\n${task.approvedPlan}`;
}

export function reviewPrompt(task: Task): string {
  if (!task.approvedPlan) throw new Error('Approve a plan first.');
  return `Review the current changes against the approved plan below. Check for bugs, regressions and missing requirements. Report actionable findings as a concise list with file and line references. Do not edit files.\n\nTask:\n${task.description}\n\nApproved plan:\n${task.approvedPlan}`;
}
