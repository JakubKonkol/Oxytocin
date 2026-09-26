import { z } from 'zod';
import { AppInfoSchema, HostStatusSchema } from '../domain/app-info';
import { SettingsPatchSchema, SettingsSchema } from '../domain/settings';
import { WorkspaceLoadResultSchema, WorkspaceStateSchema } from '../domain/workspace';
import { UiStatePatchSchema, UiStateSchema } from '../domain/ui-state';
import { CreateTerminalRequestSchema, ProjectIdSchema, TerminalIdSchema, TerminalInfoSchema } from '../domain/terminal';
import { TerminalProfileSchema } from '../domain/terminal-profile';
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
  /** Writes keys into settings.json preserving comments; `null` removes a key. */
  'settings:update': { req: SettingsPatchSchema, res: SettingsSchema },
  'workspace:load': { req: z.object({ projectId: ProjectIdSchema }), res: WorkspaceLoadResultSchema },
  'workspace:save': { req: WorkspaceStateSchema, res: z.void() },
  'ui:getState': { req: z.null().optional(), res: UiStateSchema },
  'ui:patchState': { req: UiStatePatchSchema, res: UiStateSchema },
  'terminals:create': { req: CreateTerminalRequestSchema, res: TerminalInfoSchema },
  'terminals:kill': { req: z.object({ id: TerminalIdSchema, force: z.boolean().optional() }), res: z.void() },
  'terminals:restart': { req: z.object({ id: TerminalIdSchema }), res: TerminalInfoSchema },
  'terminals:rename': { req: z.object({ id: TerminalIdSchema, title: z.string().max(80) }), res: z.void() },
  'terminals:dispose': { req: z.object({ id: TerminalIdSchema }), res: z.void() },
  'terminals:list': {
    req: z.object({ projectId: ProjectIdSchema.optional() }).optional(),
    res: z.array(TerminalInfoSchema),
  },
  'clipboard:read': { req: z.null().optional(), res: z.object({ text: z.string(), hasImage: z.boolean() }) },
  'clipboard:writeText': { req: z.object({ text: z.string().max(10_000_000) }), res: z.void() },
  'terminals:clearBell': { req: z.object({ id: TerminalIdSchema }), res: z.void() },
  'fs:statMany': {
    req: z.object({ baseDirs: z.array(z.string()).max(4), paths: z.array(z.string().max(4096)).max(50) }),
    res: z.array(z.object({ path: z.string(), resolved: z.string().nullable(), isFile: z.boolean() })),
  },
  'editor:open': {
    req: z.object({ path: z.string().min(1), line: z.number().int().optional(), column: z.number().int().optional() }),
    res: z.void(),
  },
  'shell:openExternal': { req: z.object({ url: z.string().url() }), res: z.void() },
  'terminals:profiles': { req: z.null().optional(), res: z.array(TerminalProfileSchema) },
} as const satisfies Record<InvokeChannel, InvokeSpec>;

export type InvokeReq<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['req']>;
export type InvokeReqParsed<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['req']>;
export type InvokeRes<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['res']>;
