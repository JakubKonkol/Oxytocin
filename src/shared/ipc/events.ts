import { z } from 'zod';
import { HostStatusSchema } from '../domain/app-info';
import { SettingsSchema } from '../domain/settings';
import { TerminalIdSchema, TerminalInfoSchema } from '../domain/terminal';
import type { EventChannel } from './channels';

/** Push events main → renderer. */
export const eventContract = {
  'settings:changed': SettingsSchema,
  'hosts:status': z.array(HostStatusSchema),
  'terminals:updated': TerminalInfoSchema,
  'terminals:removed': z.object({ id: TerminalIdSchema }),
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventPayload<E extends EventChannel> = z.output<(typeof eventContract)[E]>;
