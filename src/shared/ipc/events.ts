import { z } from 'zod';
import { AgentInfoWithTerminalSchema } from '../domain/agent';
import { RepoStatusSchema } from '../domain/git';
import { ProjectRuntimeStatusSchema } from '../domain/activity';
import { HostStatusSchema } from '../domain/app-info';
import { SettingsSchema } from '../domain/settings';
import { ProjectIdSchema, TerminalIdSchema, TerminalInfoSchema } from '../domain/terminal';
import { ProjectSchema } from '../domain/project';
import type { EventChannel } from './channels';

/** In-app toast requested by main. */
export const NotificationPayloadSchema = z.object({
  kind: z.enum(['info', 'success', 'warning', 'error']),
  message: z.string(),
  description: z.string().optional(),
  /** Terminal the toast is about ("Show" action). */
  target: z.object({ projectId: ProjectIdSchema, terminalId: TerminalIdSchema }).optional(),
  /** Skip the toast when the target terminal is visible. */
  onlyIfHidden: z.boolean().optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

/** Push events main → renderer. */
export const eventContract = {
  'settings:changed': SettingsSchema,
  'hosts:status': z.array(HostStatusSchema),
  'terminals:updated': TerminalInfoSchema,
  'terminals:removed': z.object({ id: TerminalIdSchema }),
  'agents:updated': z.array(AgentInfoWithTerminalSchema),
  'projects:changed': z.array(ProjectSchema),
  'projects:active': z.object({ id: ProjectIdSchema.nullable() }),
  /** In-app toast requested by main (e.g. a project added from the command line). */
  'notifications:show': NotificationPayloadSchema,
  'projects:activity': z.array(ProjectRuntimeStatusSchema),
  /** Focus a terminal (e.g. an OS notification was clicked): activate its project and panel. */
  'terminals:reveal': z.object({ projectId: ProjectIdSchema, terminalId: TerminalIdSchema }),
  'git:status': RepoStatusSchema,
  /** Terminal editor preset: open a terminal panel running the editor command. */
  'editor:openInTerminal': z.object({ projectId: ProjectIdSchema.nullable(), cwd: z.string(), command: z.string() }),
  'git:fileTouched': z.object({ projectId: ProjectIdSchema, paths: z.array(z.string()), at: z.number() }),
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventPayload<E extends EventChannel> = z.output<(typeof eventContract)[E]>;
