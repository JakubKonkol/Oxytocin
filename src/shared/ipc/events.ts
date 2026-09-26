import { z } from 'zod';
import { AgentInfoWithTerminalSchema } from '../domain/agent';
import { HostStatusSchema } from '../domain/app-info';
import { SettingsSchema } from '../domain/settings';
import { ProjectIdSchema, TerminalIdSchema, TerminalInfoSchema } from '../domain/terminal';
import { ProjectSchema } from '../domain/project';
import type { EventChannel } from './channels';

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
  'notifications:show': z.object({
    kind: z.enum(['info', 'success', 'warning', 'error']),
    message: z.string(),
    description: z.string().optional(),
  }),
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventPayload<E extends EventChannel> = z.output<(typeof eventContract)[E]>;
