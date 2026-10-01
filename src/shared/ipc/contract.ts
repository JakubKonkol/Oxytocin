import { z } from 'zod';
import { ProjectRuntimeStatusSchema } from '../domain/activity';
import { AgentInfoWithTerminalSchema } from '../domain/agent';
import {
  ContributionsSchema,
  InstalledPluginSchema,
  OpenViewRequestSchema,
  PluginDescriptorSchema,
  StatusBarItemStateSchema,
  ViewEnvelopeSchema,
} from '../domain/plugin';
import { FileDiffContentSchema, FileDiffRequestSchema, RepoStatusSchema } from '../domain/git';
import { AppInfoSchema, HostStatusSchema } from '../domain/app-info';
import { SettingsPatchSchema, SettingsSchema } from '../domain/settings';
import { UpdateStateSchema } from '../domain/updates';
import { WorkspaceLoadResultSchema, WorkspaceStateSchema } from '../domain/workspace';
import { UiStatePatchSchema, UiStateSchema } from '../domain/ui-state';
import { ConfirmResultSchema } from '../domain/confirm';
import { McpCliResultSchema, McpStateSchema } from '../domain/mcp';
import { QuickPickResultSchema } from '../domain/quick-pick';
import { KeybindingsStateSchema, UserKeybindingSchema } from '../domain/keybindings';
import { CreateTerminalRequestSchema, ProjectIdSchema, TerminalIdSchema, TerminalInfoSchema } from '../domain/terminal';
import { TerminalProfileSchema } from '../domain/terminal-profile';
import { AddProjectResultSchema, ProjectPatchSchema, ProjectSchema } from '../domain/project';
import {
  ImportCandidateSchema,
  INSTRUCTIONS_FILES,
  ProjectResourcesSchema,
  ResourceTestResultSchema,
  SecretChangeSchema,
  SecretKeySchema,
  SecretsStatusSchema,
} from '../domain/project-resources';
import {
  EnsembleChangeSchema,
  EnsembleChecksSchema,
  EnsembleCliSchema,
  EnsembleRecordSchema,
  FinishActionSchema,
} from '../domain/ensemble';
import type { InvokeChannel } from './channels';

/** What the Ensemble panel may ask the conductor to do (the rest comes from agents or effects). */
export const EnsembleUserEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('resume-interrupted') }),
  z.object({
    type: z.literal('gate'),
    stageId: z.string().max(64),
    decision: z.enum(['approve', 'reject', 'stop']),
    comment: z.string().max(20_000).optional(),
    editedBody: z.string().max(200_000).optional(),
  }),
  z.object({ type: z.literal('resolve-need'), needId: z.string().max(64), action: z.string().max(40) }),
  z.object({ type: z.literal('message'), to: z.string().max(64), text: z.string().min(1).max(8000) }),
  z.object({ type: z.literal('note'), by: z.literal('user'), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('mark-done'), agentId: z.string().max(64), summary: z.string().max(4000) }),
  z.object({ type: z.literal('take-over'), agentId: z.string().max(64) }),
  z.object({ type: z.literal('hand-back'), agentId: z.string().max(64) }),
  z.object({ type: z.literal('restart-agent'), agentId: z.string().max(64) }),
  z.object({ type: z.literal('advisor-enabled'), enabled: z.boolean() }),
]);
export type EnsembleUserEvent = z.infer<typeof EnsembleUserEventSchema>;

interface InvokeSpec {
  req: z.ZodType;
  res: z.ZodType;
}

/** Source of truth for request/response IPC (renderer → main). Requests are validated in main. */
export const invokeContract = {
  'app:getInfo': { req: z.null().optional(), res: AppInfoSchema },
  'app:getHostStatus': { req: z.null().optional(), res: z.array(HostStatusSchema) },
  /** LICENSE (MIT) or THIRD_PARTY_NOTICES.md shipped with the app (About / Help → Third-Party Notices). */
  'app:readLegal': { req: z.object({ doc: z.enum(['license', 'notices']) }), res: z.object({ text: z.string() }) },
  /** Auto-update (M9-T2). `check` resolves once the check is done; the download continues in the background. */
  'updates:getState': { req: z.null().optional(), res: UpdateStateSchema },
  'updates:check': { req: z.null().optional(), res: UpdateStateSchema },
  /** Quits through QuitGuard and restarts into the downloaded update; false when no update is ready. */
  'updates:restart': { req: z.null().optional(), res: z.boolean() },
  'settings:get': { req: z.null().optional(), res: SettingsSchema },
  /** Writes keys into settings.json preserving comments; `null` removes a key. */
  'settings:update': { req: SettingsPatchSchema, res: SettingsSchema },
  /** Invalid values in settings.json (the defaults are used instead). */
  'settings:problems': {
    req: z.null().optional(),
    res: z.array(z.object({ key: z.string(), message: z.string() })),
  },
  /** Opens settings.json in the configured editor (created when missing). */
  'settings:openFile': { req: z.null().optional(), res: z.void() },
  'workspace:load': { req: z.object({ projectId: ProjectIdSchema }), res: WorkspaceLoadResultSchema },
  'workspace:save': { req: WorkspaceStateSchema, res: z.void() },
  'ui:getState': { req: z.null().optional(), res: UiStateSchema },
  'ui:patchState': { req: UiStatePatchSchema, res: UiStateSchema },
  /** The renderer answers a `ui:quickPick` request (plugin `oxy.ui.showQuickPick`). */
  'ui:quickPickResult': { req: QuickPickResultSchema, res: z.void() },
  /** The renderer answers a `ui:confirm` request. */
  'ui:confirmResult': { req: ConfirmResultSchema, res: z.void() },
  /** A button of a toast with actions was clicked (null: the toast closed without one). */
  'notifications:action': {
    req: z.object({ requestId: z.string().min(1).max(100), actionId: z.string().max(100).nullable() }),
    res: z.void(),
  },
  /** User overrides from keybindings.json (M7-T2). */
  'keybindings:get': { req: z.null().optional(), res: KeybindingsStateSchema },
  /** Replaces the user entries of one command (empty = back to the defaults), keeping comments. */
  'keybindings:setForCommand': {
    req: z.object({ command: z.string().min(1).max(200), entries: z.array(UserKeybindingSchema).max(20) }),
    res: KeybindingsStateSchema,
  },
  /** Opens keybindings.json in the configured editor (created from a template when missing). */
  'keybindings:openFile': { req: z.null().optional(), res: z.void() },
  'projects:list': { req: z.null().optional(), res: z.array(ProjectSchema) },
  'projects:getActive': { req: z.null().optional(), res: z.object({ id: ProjectIdSchema.nullable() }) },
  'projects:add': { req: z.object({ path: z.string().min(1) }), res: AddProjectResultSchema },
  'projects:remove': { req: z.object({ id: ProjectIdSchema, killTerminals: z.boolean() }), res: z.void() },
  'projects:update': { req: ProjectPatchSchema, res: ProjectSchema },
  'projects:reorder': { req: z.object({ ids: z.array(ProjectIdSchema) }), res: z.void() },
  'projects:setActive': { req: z.object({ id: ProjectIdSchema.nullable() }), res: z.void() },
  'projects:pickFolder': { req: z.null().optional(), res: z.string().nullable() },
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
  'projects:getActivity': { req: z.null().optional(), res: z.array(ProjectRuntimeStatusSchema) },
  'terminals:markSeen': { req: z.object({ id: TerminalIdSchema }), res: z.void() },
  /** Waiting-agent count for the taskbar overlay (Windows, pre-rendered PNG data URL) / dock badge. */
  'window:setAttention': {
    req: z.object({
      count: z.number().int().min(0),
      overlay: z.string().startsWith('data:image/png;base64,').max(200_000).optional(),
    }),
    res: z.void(),
  },
  'git:getStatus': { req: z.object({ projectId: ProjectIdSchema }), res: RepoStatusSchema.nullable() },
  'git:refresh': { req: z.object({ projectId: ProjectIdSchema }), res: z.void() },
  'git:getFileDiff': { req: FileDiffRequestSchema, res: FileDiffContentSchema },
  'plugins:list': { req: z.null().optional(), res: z.array(PluginDescriptorSchema) },
  'plugins:contributions': { req: z.null().optional(), res: ContributionsSchema },
  'plugins:setEnabled': { req: z.object({ id: z.string(), enabled: z.boolean() }), res: z.void() },
  /** Plugins → Reload: rescans manifests, reloads the backend and the plugin's views. */
  'plugins:reload': { req: z.object({ id: z.string() }), res: z.void() },
  /** "Load plugin from folder…" (developer mode): adds the picked folder to `plugins.devPaths`. */
  'plugins:loadFromFolder': {
    req: z.null().optional(),
    res: z.object({ path: z.string(), id: z.string().optional(), errors: z.array(z.string()) }).nullable(),
  },
  'plugins:removeDevPath': { req: z.object({ path: z.string() }), res: z.void() },
  /** Installs a plugin into userData/plugins from a folder or a .zip picked by the user; null = cancelled (M9-T3). */
  'plugins:install': { req: z.object({ kind: z.enum(['folder', 'zip']) }), res: InstalledPluginSchema.nullable() },
  /** Removes a plugin installed by the user. */
  'plugins:uninstall': { req: z.object({ id: z.string() }), res: z.void() },
  'plugins:openUserFolder': { req: z.null().optional(), res: z.void() },
  /** Developer mode: DevTools of the window (plugin iframes are selectable frames there). */
  'plugins:openDevTools': { req: z.null().optional(), res: z.void() },
  'plugins:executeCommand': {
    req: z.object({ id: z.string(), args: z.array(z.unknown()).optional() }),
    res: z.unknown(),
  },
  'plugins:logs': {
    req: z.object({ id: z.string() }),
    res: z.array(z.object({ at: z.number(), level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string() })),
  },
  /** Fires an activation event (\`onView:<id>\`, \`onPanel:<type>\`…); returns the activated plugin ids. */
  'plugins:activate': { req: z.object({ event: z.string().min(1) }), res: z.array(z.string()) },
  'plugins:viewOpened': { req: OpenViewRequestSchema, res: z.void() },
  'plugins:statusBar': { req: z.null().optional(), res: z.array(StatusBarItemStateSchema) },
  'plugins:viewClosed': { req: z.object({ viewId: z.string() }), res: z.void() },
  'plugins:viewVisibility': { req: z.object({ viewId: z.string(), visible: z.boolean() }), res: z.void() },
  'plugins:viewMessage': { req: z.object({ viewId: z.string(), envelope: ViewEnvelopeSchema }), res: z.void() },
  'agents:list': { req: z.null().optional(), res: z.array(AgentInfoWithTerminalSchema) },
  'fs:statMany': {
    req: z.object({ baseDirs: z.array(z.string()).max(4), paths: z.array(z.string().max(4096)).max(50) }),
    res: z.array(z.object({ path: z.string(), resolved: z.string().nullable(), isFile: z.boolean() })),
  },
  'editor:open': {
    req: z.object({ path: z.string().min(1), line: z.number().int().optional(), column: z.number().int().optional() }),
    res: z.void(),
  },
  'shell:revealInFolder': { req: z.object({ path: z.string().min(1) }), res: z.void() },
  'shell:openExternal': { req: z.object({ url: z.string().url() }), res: z.void() },
  'terminals:profiles': { req: z.null().optional(), res: z.array(TerminalProfileSchema) },
  /** Oxytocin's MCP server: status, tools with their switches and policies, recent calls. */
  'mcp:getState': { req: z.null().optional(), res: McpStateSchema },
  /** Registers the server in Claude Code (user scope) and removes the old `oxytocin-runner` entry. */
  'mcp:connectClaude': { req: z.null().optional(), res: McpCliResultSchema.extend({ migrated: z.boolean() }) },
  'mcp:disconnectClaude': { req: z.null().optional(), res: McpCliResultSchema },
  /** Asks Claude Code whether the server is registered at the current address (null: unknown). */
  'mcp:checkClaude': { req: z.null().optional(), res: z.boolean().nullable() },
  /** The `claude mcp add` command line and `mcpServers` JSON for other clients (with the token). */
  'mcp:clientConfig': { req: z.null().optional(), res: z.object({ command: z.string(), json: z.string() }) },
  /** A new token; Claude Code is connected again when it was connected. */
  'mcp:resetToken': {
    req: z.null().optional(),
    res: McpCliResultSchema.extend({ migrated: z.boolean() }).nullable(),
  },
  'mcp:clearLog': { req: z.null().optional(), res: z.void() },
  /** A project's resources (Plan 02) with which secrets are set; never the secrets themselves. */
  'resources:get': {
    req: z.object({ projectId: ProjectIdSchema }),
    res: z.object({
      resources: ProjectResourcesSchema,
      secrets: SecretsStatusSchema,
      /** Written by a newer Oxytocin: saving replaces it. */
      unreadable: z.boolean(),
      /** `.oxytocin/project.json` exists in the repository. */
      repositoryFile: z.boolean(),
    }),
  },
  /** Saves the resources; secret changes are write-only (a value, null to remove, or an import token). */
  'resources:save': {
    req: z.object({
      projectId: ProjectIdSchema,
      resources: z.unknown(),
      secrets: z.array(SecretChangeSchema).max(200).default([]),
    }),
    res: ProjectResourcesSchema,
  },
  /** "Test connection" for a database or API as edited (unsaved values typed in the dialog included). */
  'resources:test': {
    req: z.object({
      projectId: ProjectIdSchema,
      kind: z.enum(['database', 'api']),
      resource: z.unknown(),
      /** Typed but unsaved secrets (null: removed in the dialog). */
      secrets: z.record(SecretKeySchema, z.string().max(20_000).nullable()).default({}),
      /** Secrets of an imported candidate, by key → import token. */
      importTokens: z.record(SecretKeySchema, z.string().max(200)).default({}),
    }),
    res: ResourceTestResultSchema,
  },
  /** Connection strings found in the project's files (.env, appsettings, Spring, docker-compose, Prisma). */
  'resources:import': { req: z.object({ projectId: ProjectIdSchema }), res: z.array(ImportCandidateSchema) },
  /** The brief agents get about the project's resources (preview in the Agents tab). */
  'resources:brief': { req: z.object({ projectId: ProjectIdSchema }), res: z.object({ text: z.string() }) },
  /** Writes (and from then on keeps up to date) the managed block in AGENTS.md or CLAUDE.md; `none` removes it. */
  'resources:writeInstructions': {
    req: z.object({ projectId: ProjectIdSchema, file: z.enum(INSTRUCTIONS_FILES) }),
    res: z.object({ path: z.string().nullable(), written: z.boolean() }),
  },
  /** Writes `.oxytocin/project.json` (no secrets, no production resources). */
  'resources:saveToRepository': { req: z.object({ projectId: ProjectIdSchema }), res: z.object({ path: z.string() }) },
  /** A file picker for resource paths; the result is relative to the project root when inside it. */
  'resources:pickFile': {
    req: z.object({ projectId: ProjectIdSchema, purpose: z.enum(['sqlite', 'env', 'log', 'openapi', 'certificate']) }),
    res: z.string().nullable(),
  },
  /** Which secrets of a project are set (`<resourceId>/<key>`), and whether they are encrypted. */
  'secrets:status': { req: z.object({ projectId: ProjectIdSchema }), res: SecretsStatusSchema },
  /** Write-only: there is no channel that returns a secret. */
  'secrets:set': {
    req: z.object({
      projectId: ProjectIdSchema,
      resourceId: z.string().min(1).max(64),
      key: SecretKeySchema,
      value: z.string().max(20_000),
    }),
    res: SecretsStatusSchema,
  },
  'secrets:delete': {
    req: z.object({ projectId: ProjectIdSchema, resourceId: z.string().min(1).max(64), key: SecretKeySchema }),
    res: SecretsStatusSchema,
  },
  /** Ensemble (Plan 03): the tasks of a project (latest events only). */
  'ensemble:list': { req: z.object({ projectId: ProjectIdSchema.optional() }), res: z.array(EnsembleRecordSchema) },
  /** A new draft from a template. */
  'ensemble:create': {
    req: z.object({
      projectId: ProjectIdSchema,
      templateId: z.string().max(64),
      title: z.string().max(120).optional(),
      description: z.string().max(50_000).optional(),
    }),
    res: EnsembleRecordSchema,
  },
  /** Saves the builder's task (validated in main; a running task only takes a new title). */
  'ensemble:save': { req: z.object({ task: z.unknown() }), res: EnsembleRecordSchema },
  'ensemble:delete': { req: z.object({ taskId: z.string().max(64) }), res: z.void() },
  'ensemble:duplicate': { req: z.object({ taskId: z.string().max(64) }), res: EnsembleRecordSchema },
  /** Start, pause, a gate decision, an answer to an item of the inbox… */
  'ensemble:command': {
    req: z.object({ taskId: z.string().max(64), event: EnsembleUserEventSchema }),
    res: z.object({ error: z.string().optional() }),
  },
  /** The user answers an agent's question. */
  'ensemble:answer': {
    req: z.object({ taskId: z.string().max(64), questionId: z.string().max(64), answer: z.string().min(1).max(8000) }),
    res: z.object({ error: z.string().optional() }),
  },
  /** Builder checks: CLIs installed, MCP server, Claude Code Bridge, git repository. */
  'ensemble:checks': {
    req: z.object({ projectId: ProjectIdSchema, clis: z.array(EnsembleCliSchema).max(12) }),
    res: EnsembleChecksSchema,
  },
  /** Files changed in the task's worktree: whole task (base → now) or between two checkpoints. */
  'ensemble:changes': {
    req: z.object({
      taskId: z.string().max(64),
      from: z.string().max(80).optional(),
      to: z.string().max(80).optional(),
    }),
    res: z.array(EnsembleChangeSchema),
  },
  'ensemble:fileDiff': {
    req: z.object({
      taskId: z.string().max(64),
      path: z.string().min(1).max(4096),
      oldPath: z.string().max(4096).optional(),
      from: z.string().max(80).optional(),
      to: z.string().max(80).optional(),
    }),
    res: z.object({ original: z.string().nullable(), modified: z.string().nullable() }),
  },
  /** Merge, squash, keep or discard the task's branch. */
  'ensemble:finish': {
    req: z.object({ taskId: z.string().max(64), action: FinishActionSchema }),
    res: z.object({ detail: z.string() }),
  },
  /** A Markdown report of the run (a PR description). */
  'ensemble:report': { req: z.object({ taskId: z.string().max(64) }), res: z.object({ text: z.string() }) },
  /** Opens the task's working folder in the editor or the file manager. */
  'ensemble:openFolder': {
    req: z.object({ taskId: z.string().max(64), target: z.enum(['editor', 'files']) }),
    res: z.void(),
  },
} as const satisfies Record<InvokeChannel, InvokeSpec>;

export type InvokeReq<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['req']>;
export type InvokeReqParsed<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['req']>;
export type InvokeRes<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]['res']>;
