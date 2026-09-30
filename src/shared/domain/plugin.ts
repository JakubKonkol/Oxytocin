import { z } from 'zod';
import { McpContributionSchema } from './mcp';

export const PLUGIN_PERMISSIONS = [
  'projects.read',
  'terminals.read-metadata',
  'terminals.create',
  'terminals.write',
  'terminals.read-output',
  'terminals.env',
  'agents.read',
  'agents.annotate',
  'git.read',
  'fs.read-project',
  'fs.read-home',
  'net.listen-local',
  'net.fetch',
  'notifications.os',
  'mcp.tools',
] as const;
export const PluginPermissionSchema = z.enum(PLUGIN_PERMISSIONS);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

/** What each permission allows, shown in the consent dialog and the plugin manager (07 §9). */
export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  'projects.read': 'See your projects (names and folders)',
  'terminals.read-metadata': 'See your terminals (titles, folders, running processes)',
  'terminals.create': 'Open new terminals and run commands in them',
  'terminals.write': 'Type into your terminals',
  'terminals.read-output': 'Read everything your terminals print',
  'terminals.env': 'Add environment variables to new terminals',
  'agents.read': 'See the state of AI agents in your terminals',
  'agents.annotate': 'Report AI agent sessions',
  'git.read': 'See git changes in your projects',
  'fs.read-project': 'Read files in your projects',
  'fs.read-home': 'Read files in your home folder',
  'net.listen-local': 'Accept connections on this computer (a local server)',
  'net.fetch': 'Download data from the internet',
  'notifications.os': 'Show system notifications',
  'mcp.tools': "Give AI agents tools to use (through Oxytocin's MCP server)",
};

/** Used as the host of `oxy-plugin://<id>`: lowercase, dot-separated. */
export const PluginIdSchema = z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, 'must look like "publisher.name"');

const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => !/^([a-zA-Z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'),
    'must be a relative path inside the plugin',
  );

const ActivationEventSchema = z
  .string()
  .regex(
    /^(\*|onStartup|onProjectOpen|onView:.+|onPanel:.+|onCommand:.+|onAgentDetected:.+|onMcpTool:.+)$/,
    'unknown activation event',
  );

export const PluginViewContributionSchema = z.object({
  id: z.string().min(1),
  slot: z.literal('sidebar'),
  title: z.string().min(1),
  entry: RelativePathSchema,
  icon: RelativePathSchema.optional(),
  order: z.number().default(1000),
  initialHeight: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
});

export const PluginPanelContributionSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  entry: RelativePathSchema,
  icon: RelativePathSchema.optional(),
  singleton: z.union([z.literal('global'), z.literal('project'), z.literal(false)]).default(false),
  /** Listed under Tools in the workspace's "+" menu and the right sidebar's "Add tool" menu (opened without params). */
  showInAddMenu: z.boolean().default(false),
});

export const StatusBarItemContributionSchema = z.object({
  id: z.string().min(1),
  alignment: z.enum(['left', 'right']).default('right'),
  priority: z.number().default(0),
});

export const CommandContributionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  icon: z.string().optional(),
});

const ConfigurationPropertySchema = z.object({
  type: z.enum(['boolean', 'number', 'integer', 'string', 'array', 'object']),
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  enumDescriptions: z.array(z.string()).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  description: z.string().optional(),
  markdownDescription: z.string().optional(),
});
export type ConfigurationProperty = z.infer<typeof ConfigurationPropertySchema>;

export const ConfigurationContributionSchema = z
  .object({
    prefix: z.string().regex(/^[a-zA-Z][\w-]*$/),
    properties: z.record(z.string(), ConfigurationPropertySchema),
  })
  .refine((c) => Object.keys(c.properties).every((k) => k.startsWith(`${c.prefix}.`)), {
    message: 'every configuration key must start with the declared prefix',
  });

export const FileOpenerContributionSchema = z.object({
  id: z.string().min(1),
  extensions: z.array(z.string().regex(/^\.[\w.-]+$/)).min(1),
  panelType: z.string().min(1),
  title: z.string().min(1),
  default: z.boolean().default(false),
});

export const PluginTerminalProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['shell', 'agent']).default('shell'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string().nullable()).optional(),
  icon: z.string().optional(),
});

export const PluginAgentRuleSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.enum(['anthropic', 'openai', 'google', 'multi', 'other']).default('other'),
  processNames: z.array(z.string()).default([]),
  /** Regular-expression sources, compiled case-insensitively by the core. */
  commandLinePatterns: z.array(z.string()).optional(),
  icon: z.string().default('agent'),
});

export const PluginContributesSchema = z.object({
  views: z.array(PluginViewContributionSchema).default([]),
  panels: z.array(PluginPanelContributionSchema).default([]),
  statusBarItems: z.array(StatusBarItemContributionSchema).default([]),
  commands: z.array(CommandContributionSchema).default([]),
  configuration: ConfigurationContributionSchema.optional(),
  fileOpeners: z.array(FileOpenerContributionSchema).default([]),
  terminalProfiles: z.array(PluginTerminalProfileSchema).default([]),
  agents: z.array(PluginAgentRuleSchema).default([]),
  /** Tools for AI agents, offered by Oxytocin's MCP server (needs the `mcp.tools` permission). */
  mcp: McpContributionSchema.optional(),
});
export type PluginContributes = z.infer<typeof PluginContributesSchema>;

/** The `oxytocin` section of a plugin's package.json. */
export const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    displayName: z.string().min(1),
    description: z.string().optional(),
    publisher: z.string().min(1),
    icon: RelativePathSchema.optional(),
    engine: z.string().min(1),
    main: RelativePathSchema.optional(),
    activationEvents: z.array(ActivationEventSchema).default([]),
    permissions: z.array(PluginPermissionSchema).default([]),
    contributes: PluginContributesSchema.default(() => PluginContributesSchema.parse({})),
  })
  .refine((m) => !m.contributes.mcp || m.permissions.includes('mcp.tools'), {
    message: 'contributes.mcp needs the "mcp.tools" permission',
    path: ['permissions'],
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginSourceSchema = z.enum(['builtin', 'user', 'dev']);
export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const PluginStateSchema = z.enum(['enabled', 'disabled', 'invalid', 'incompatible', 'failed', 'active']);
export type PluginState = z.infer<typeof PluginStateSchema>;

/** What the core knows about a discovered plugin. */
export const PluginDescriptorSchema = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  publisher: z.string().optional(),
  source: PluginSourceSchema,
  path: z.string(),
  state: PluginStateSchema,
  errors: z.array(z.string()).optional(),
  /** Other copies of the same id that were shadowed (dev > user > builtin). */
  shadowed: z.array(z.object({ source: PluginSourceSchema, path: z.string() })).optional(),
  manifest: PluginManifestSchema.optional(),
});
export type PluginDescriptor = z.infer<typeof PluginDescriptorSchema>;

/** Result of installing a plugin from a folder or a .zip archive (M9-T3). */
export const InstalledPluginSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string(),
  replaced: z.boolean(),
  needsNewConsent: z.boolean(),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

/** Aggregated contributions of enabled plugins, tagged with the contributing plugin. */
export const ContributionsSchema = z.object({
  views: z.array(PluginViewContributionSchema.extend({ pluginId: z.string() })),
  panels: z.array(PluginPanelContributionSchema.extend({ pluginId: z.string() })),
  statusBarItems: z.array(StatusBarItemContributionSchema.extend({ pluginId: z.string() })),
  commands: z.array(CommandContributionSchema.extend({ pluginId: z.string() })),
  configuration: z.array(ConfigurationContributionSchema.and(z.object({ pluginId: z.string() }))),
  fileOpeners: z.array(FileOpenerContributionSchema.extend({ pluginId: z.string() })),
  terminalProfiles: z.array(PluginTerminalProfileSchema.extend({ pluginId: z.string() })),
  agents: z.array(PluginAgentRuleSchema.extend({ pluginId: z.string() })),
});
export type Contributions = z.infer<typeof ContributionsSchema>;

export const ViewEnvelopeSchema = z.union([
  z.object({ kind: z.literal('msg'), payload: z.unknown() }),
  z.object({ kind: z.literal('req'), id: z.number(), method: z.string().min(1), payload: z.unknown() }),
  z.object({ kind: z.literal('res'), id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('res'), id: z.number(), ok: z.literal(false), error: z.string() }),
  z.object({ kind: z.literal('evt'), name: z.string(), payload: z.unknown() }),
]);

export const OpenViewRequestSchema = z.object({
  viewId: z.string().regex(/^[\w.-]{1,120}$/),
  pluginId: z.string(),
  kind: z.enum(['view', 'panel']),
  providerId: z.string(),
  projectId: z.string().optional(),
  params: z.unknown().optional(),
  visible: z.boolean(),
});

export const StatusBarItemStateSchema = z.object({
  pluginId: z.string(),
  id: z.string(),
  text: z.string(),
  tooltip: z.string().optional(),
  color: z.enum(['default', 'success', 'warning', 'danger', 'accent']).optional(),
  command: z.union([z.string(), z.object({ id: z.string(), args: z.array(z.unknown()).optional() })]).optional(),
  visible: z.boolean(),
});
export type StatusBarItemState = z.infer<typeof StatusBarItemStateSchema>;

export const OpenPanelRequestSchema = z.object({
  panelType: z.string(),
  projectId: z.string().optional(),
  params: z.unknown().optional(),
  title: z.string().optional(),
  placement: z.enum(['active-group', 'right', 'below']).optional(),
});
