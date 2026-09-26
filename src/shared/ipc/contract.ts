import { z } from 'zod';
import { AppInfoSchema, HostStatusSchema } from '../domain/app-info';
import { SettingsSchema } from '../domain/settings';
import type { InvokeChannel } from './channels';

interface InvokeSpec {
  req: z.ZodType;
  res: z.ZodType;
}

/** Source of truth for request/response IPC (renderer → main). Requests are validated in main. */
export const invokeContract = {
  'app:getInfo': { req: z.null().optional(), res: AppInfoSchema },
  'app:getHostStatus': { req: z.null().optional(), res: z.array(HostStatusSchema) },
  'settings:get': { req: z.null().optional(), res: SettingsSchema },
} as const satisfies Record<InvokeChannel, InvokeSpec>;

export type InvokeReq<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['req']>;
export type InvokeReqParsed<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['req']>;
export type InvokeRes<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['res']>;
