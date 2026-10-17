import { z } from 'zod';

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
export const TaskSchema = TaskInputSchema.extend({
  id: z.uuid(),
  projectId: z.string().min(1).max(64),
  phase: z.enum(['planning', 'ready', 'implementing', 'reviewing', 'done']),
  plan: z.string().max(90_000).default(''),
  approvedPlan: z.string().max(90_000).optional(),
  approvedAt: z.number().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
  source: z.string().optional(),
  error: z.string().optional(),
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskInputSchema>;
export type Role = z.infer<typeof RoleSchema>;

export function plannerPrompt(task: Task, document: string): string {
  return `Plan this task; do not implement it. Discuss questions with the user in this terminal. ${task.planMode ? 'Use plan mode. ' : ''}If you are Claude Code, save the final plan in your native plan document; Oxytocin will capture it. Otherwise save the final Markdown plan to ${JSON.stringify(document)}. Stop after planning: the user approves the plan in Task and a separate agent implements it.\n\nTask:\n${task.description}`;
}

export function implementationPrompt(task: Task): string {
  if (!task.approvedPlan?.trim()) throw new Error('Approve a non-empty plan first.');
  return `Implement the following user-approved plan. Follow the project's instructions and run the relevant checks.\n\nTask:\n${task.description}\n\nApproved plan:\n${task.approvedPlan}`;
}

export function reviewPrompt(task: Task): string {
  if (!task.approvedPlan) throw new Error('Approve a plan first.');
  return `Review the current changes against the approved plan below. Check for bugs, regressions and missing requirements. Report actionable findings as a concise list with file and line references. Do not edit files.\n\nTask:\n${task.description}\n\nApproved plan:\n${task.approvedPlan}`;
}
