import { z } from 'zod';

export const ProjectActivitySchema = z.enum(['none', 'idle', 'running', 'agent-working', 'attention', 'error']);
export type ProjectActivity = z.infer<typeof ProjectActivitySchema>;

export const ProjectRuntimeStatusSchema = z.object({
  projectId: z.string(),
  activity: ProjectActivitySchema,
  terminals: z.number(),
  runningProcesses: z.number(),
  agents: z.object({ working: z.number(), waiting: z.number(), idle: z.number() }),
  unseenError: z.object({ terminalId: z.string(), exitCode: z.number(), at: z.number() }).optional(),
  gitBranch: z.string().optional(),
  changesCount: z.number().optional(),
});
export type ProjectRuntimeStatus = z.infer<typeof ProjectRuntimeStatusSchema>;

export const PROJECT_ACTIVITY_LABELS: Record<ProjectActivity, string> = {
  none: 'No terminals',
  idle: 'Idle',
  running: 'Process running',
  'agent-working': 'Agent working',
  attention: 'Needs your attention',
  error: 'Process exited with an error',
};
