import { z } from 'zod';
import { AgentInfoWithTerminalSchema } from '../domain/agent';
import {
  ContributionsSchema,
  OpenPanelRequestSchema,
  PluginDescriptorSchema,
  StatusBarItemStateSchema,
  ViewEnvelopeSchema,
} from '../domain/plugin';
import { RepoStatusSchema } from '../domain/git';
import { ProjectRuntimeStatusSchema } from '../domain/activity';
import { HostStatusSchema } from '../domain/app-info';
import { SettingsSchema } from '../domain/settings';
import { ProjectIdSchema, TerminalIdSchema, TerminalInfoSchema } from '../domain/terminal';
import { ProjectSchema } from '../domain/project';
import { ConfirmRequestSchema } from '../domain/confirm';
import { McpStateSchema } from '../domain/mcp';
import { QuickPickRequestSchema } from '../domain/quick-pick';
import { KeybindingsStateSchema } from '../domain/keybindings';
import { UpdateStateSchema } from '../domain/updates';
import { MenuCommandSchema } from '../domain/app-menu';
import { EnsembleRecordSchema } from '../domain/ensemble';
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
  /** Buttons (a plugin's `showNotification` actions); the click is answered with `notifications:action`. */
  actions: z
    .array(z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(60) }))
    .max(3)
    .optional(),
  requestId: z.string().min(1).max(100).optional(),
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
  'plugins:changed': z.array(PluginDescriptorSchema),
  'plugins:contributionsChanged': ContributionsSchema,
  /** A plugin was reloaded: its views reload too. */
  'plugins:reloaded': z.object({ id: z.string() }),
  /** A terminal created by a plugin: show it as a panel. */
  'terminals:openPanel': z.object({
    terminalId: TerminalIdSchema,
    projectId: ProjectIdSchema,
    placement: z.enum(['active-group', 'right', 'below']),
    /** Reveal (activate the project and the panel) and focus it; an existing panel is only revealed with this. */
    focus: z.boolean().optional(),
  }),
  /** A plugin closed a terminal: its panel goes away too. */
  'terminals:closePanel': z.object({ terminalId: TerminalIdSchema, projectId: ProjectIdSchema }),
  /** A core command requested by a plugin (oxytocin.*). */
  'commands:run': z.object({ id: z.string(), args: z.array(z.unknown()) }),
  /** Backend → plugin view. */
  'plugins:viewMessage': z.object({ viewId: z.string(), envelope: ViewEnvelopeSchema }),
  'plugins:statusBar': z.array(StatusBarItemStateSchema),
  /** \`oxy.ui.openPanel\` from a plugin backend. */
  'plugins:openPanel': OpenPanelRequestSchema,
  'plugins:viewMeta': z.object({
    viewId: z.string(),
    title: z.string().optional(),
    badge: z
      .object({ text: z.string(), tone: z.enum(['neutral', 'warning', 'danger']).optional() })
      .nullable()
      .optional(),
  }),
  /** Terminal editor preset: open a terminal panel running the editor command. */
  'editor:openInTerminal': z.object({ projectId: ProjectIdSchema.nullable(), cwd: z.string(), command: z.string() }),
  /** "Open in editor" with the built-in editor (`editor.preset: oxytocin`): show a project file. */
  'editor:openBuiltin': z.object({
    projectId: ProjectIdSchema,
    path: z.string().min(1),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
  }),
  'git:fileTouched': z.object({ projectId: ProjectIdSchema, paths: z.array(z.string()), at: z.number() }),
  /** Show a plugin's quick pick in the command palette; answered with `ui:quickPickResult`. */
  'ui:quickPick': QuickPickRequestSchema,
  /** Ask the user to confirm something in the window's own dialog; answered with `ui:confirmResult`. */
  'ui:confirm': ConfirmRequestSchema,
  /** keybindings.json changed (editor or external edit). */
  'keybindings:changed': KeybindingsStateSchema,
  /** Auto-update progress (M9-T2). */
  'updates:state': UpdateStateSchema,
  /** A `ui:confirm` request nobody needs anymore (it timed out, or the tool call was cancelled): close its dialog. */
  'ui:confirmDismiss': z.object({ requestId: z.string().min(1).max(100) }),
  /** The MCP server's status, tools or call log changed. */
  'mcp:state': McpStateSchema,
  /** An agent asked to show a file (`oxy_open_file`). */
  'mcp:openFile': z.object({
    projectId: ProjectIdSchema,
    path: z.string().min(1),
    line: z.number().int().min(1).optional(),
  }),
  /** A project's resources changed (context menu links, the Project settings dialog). */
  'resources:changed': z.object({ projectId: ProjectIdSchema }),
  /** An item of the native application menu (macOS) was chosen. */
  'app:menuCommand': z.object({ command: MenuCommandSchema }),
  /** A toast with buttons was withdrawn (answered elsewhere, no longer relevant, or timed out): close it. */
  'notifications:dismiss': z.object({ requestId: z.string().min(1).max(100) }),
  /** An Ensemble task or its run changed (latest events only). */
  'ensemble:changed': EnsembleRecordSchema,
  'ensemble:removed': z.object({ taskId: z.string(), projectId: ProjectIdSchema }),
  /** Open the Ensemble panel of a project at a task (a notification was clicked). */
  'ensemble:open': z.object({ projectId: ProjectIdSchema, taskId: z.string().optional() }),
  /** A task needs the user or finished: a toast unless its Ensemble panel is on screen. */
  'ensemble:notify': z.object({
    title: z.string(),
    body: z.string(),
    level: z.enum(['info', 'warning', 'error']),
    projectId: ProjectIdSchema,
    taskId: z.string(),
  }),
} as const satisfies Record<EventChannel, z.ZodType>;

export type EventPayload<E extends EventChannel> = z.output<(typeof eventContract)[E]>;
