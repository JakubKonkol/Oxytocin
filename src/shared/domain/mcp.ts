import { z } from 'zod';

/**
 * Oxytocin's MCP server (the "hub"): one local server AI agents connect to, with core tools (`oxy_*`) and tools
 * contributed by plugins (`contributes.mcp`, `oxy.mcp.registerTool`).
 */

/** MCP tool names (Claude Code shows them as `mcp__oxytocin__<name>`). */
export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** A plugin's tool prefix: its tools are named `<prefix>_…`. */
export const MCP_PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
/** Prefix of the core tools; plugins cannot use it. */
export const CORE_TOOL_PREFIX = 'oxy';
/** Name of the server in Claude Code (`claude mcp list`) and in other clients' configs. */
export const MCP_SERVER_NAME = 'oxytocin';
export const MCP_DEFAULT_PORT = 47287;
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;
export const MCP_MAX_TIMEOUT_MS = 600_000;
/** Text results are cut at this size (with a note to the agent). */
export const MCP_MAX_TEXT_BYTES = 256 * 1024;
/** Image results larger than this are replaced by a note. */
export const MCP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const McpPolicySchema = z.enum(['allow', 'ask', 'deny']);
export type McpPolicy = z.infer<typeof McpPolicySchema>;

export const McpToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpToolAnnotations = z.infer<typeof McpToolAnnotationsSchema>;

/** A JSON Schema object for a tool's arguments; only its shape is checked (`type: "object"`). */
export const McpInputSchemaSchema = z.looseObject({ type: z.literal('object') });

export const McpToolDefinitionSchema = z.object({
  name: z.string().regex(MCP_TOOL_NAME_PATTERN, 'must match ^[a-zA-Z0-9_-]{1,64}$'),
  title: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(4000),
  inputSchema: McpInputSchemaSchema,
  annotations: McpToolAnnotationsSchema.optional(),
  timeoutMs: z.number().int().min(1000).max(MCP_MAX_TIMEOUT_MS).optional(),
});
export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>;

/** `contributes.mcp` of a plugin manifest. */
export const McpContributionSchema = z
  .object({
    prefix: z
      .string()
      .regex(MCP_PREFIX_PATTERN, 'must match ^[a-z][a-z0-9]{1,15}$')
      .refine((p) => p !== CORE_TOOL_PREFIX, `"${CORE_TOOL_PREFIX}" is reserved for Oxytocin's own tools`),
    tools: z.array(McpToolDefinitionSchema).max(100).default([]),
  })
  .refine((m) => m.tools.every((t) => t.name.startsWith(`${m.prefix}_`)), {
    message: 'every tool name must start with the declared prefix and "_"',
  })
  .refine((m) => new Set(m.tools.map((t) => t.name)).size === m.tools.length, {
    message: 'tool names must be unique',
  });
export type McpContribution = z.infer<typeof McpContributionSchema>;

export const McpContentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1).max(100) }),
]);
export type McpContent = z.infer<typeof McpContentSchema>;

export const McpToolResultSchema = z.object({
  content: z.array(McpContentSchema),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
export type McpToolResult = z.infer<typeof McpToolResultSchema>;

/** Who is calling a tool, as far as Oxytocin can tell. */
export const McpCallContextSchema = z.object({
  projectId: z.string().optional(),
  terminalId: z.string().optional(),
  agentId: z.string().optional(),
});
export type McpCallContext = z.infer<typeof McpCallContextSchema>;

export const McpToolSourceSchema = z.union([
  z.object({ kind: z.literal('core') }),
  z.object({ kind: z.literal('plugin'), pluginId: z.string(), pluginName: z.string() }),
]);
export type McpToolSource = z.infer<typeof McpToolSourceSchema>;

/** A tool as the Agent tools settings show it. */
export const McpToolInfoSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  source: McpToolSourceSchema,
  /** The user's switch (`mcp.tools.disabled`). */
  enabled: z.boolean(),
  policy: McpPolicySchema,
  /** The policy used when the user did not choose one. */
  defaultPolicy: McpPolicySchema,
  /** Agents see it in `tools/list`. */
  listed: z.boolean(),
  /** Why it is not listed although it is enabled (a name conflict, the plugin failed…). */
  problem: z.string().optional(),
});
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

export const McpCallOutcomeSchema = z.enum(['ok', 'error', 'denied', 'cancelled']);
export type McpCallOutcome = z.infer<typeof McpCallOutcomeSchema>;

/** One tool call (no arguments or results: they can contain secrets; resource tools keep a short `detail`). */
export const McpCallLogEntrySchema = z.object({
  id: z.number(),
  at: z.number(),
  tool: z.string(),
  source: z.string(),
  caller: z.string().optional(),
  durationMs: z.number(),
  outcome: McpCallOutcomeSchema,
  error: z.string().optional(),
  /** The caller's project (for the project's call log in Project settings → Agents). */
  projectId: z.string().optional(),
  /** Resource tools: the query or request line (the audit trail, without results or secrets). */
  detail: z.string().optional(),
});
export type McpCallLogEntry = z.infer<typeof McpCallLogEntrySchema>;

export const McpHubStatusSchema = z.object({
  enabled: z.boolean(),
  /** Port the server listens on (null when stopped or failed). */
  port: z.number().nullable(),
  url: z.string(),
  error: z.string().nullable(),
  /** Connected clients (open sessions). */
  sessions: z.number(),
  /** Registered in Claude Code at this address (null: unknown, e.g. Claude Code is not installed). */
  claudeConnected: z.boolean().nullable(),
  calls: z.number(),
});
export type McpHubStatus = z.infer<typeof McpHubStatusSchema>;

export const McpStateSchema = z.object({
  status: McpHubStatusSchema,
  tools: z.array(McpToolInfoSchema),
  log: z.array(McpCallLogEntrySchema),
});
export type McpState = z.infer<typeof McpStateSchema>;

export const McpCliResultSchema = z.object({ ok: z.boolean(), output: z.string() });
export type McpCliResult = z.infer<typeof McpCliResultSchema>;

/** The policy a tool gets when the user did not choose one: destructive tools ask first. */
export function defaultPolicy(annotations: McpToolAnnotations | undefined): McpPolicy {
  return annotations?.destructiveHint === true ? 'ask' : 'allow';
}

const utf8Length = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

/** Cuts a text to at most `maxBytes` UTF-8 bytes (never in the middle of a surrogate pair). */
function cutText(text: string, maxBytes: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Length(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const code = text.charCodeAt(lo - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo);
}

/**
 * A handler's return value as an MCP result: a string becomes one text item, text is cut at 256 KB and images over
 * 5 MB are replaced, each with a note the agent can read.
 */
export function normalizeToolResult(
  value: unknown,
  limits = { text: MCP_MAX_TEXT_BYTES, image: MCP_MAX_IMAGE_BYTES },
): McpToolResult {
  if (typeof value === 'string') value = { content: [{ type: 'text', text: value }] };
  if (value === undefined || value === null) value = { content: [] };
  const parsed = McpToolResultSchema.safeParse(value);
  if (!parsed.success)
    return { content: [{ type: 'text', text: 'The tool returned an invalid result.' }], isError: true };
  let textLeft = limits.text;
  const content = parsed.data.content.map((item): McpContent => {
    if (item.type === 'image') {
      const bytes = Math.floor((item.data.length * 3) / 4);
      return bytes <= limits.image
        ? item
        : {
            type: 'text',
            text: `[An image of ${Math.round(bytes / 1024)} KB was left out: images are limited to 5 MB.]`,
          };
    }
    const size = utf8Length(item.text);
    if (size <= textLeft) {
      textLeft -= size;
      return item;
    }
    const kept = cutText(item.text, Math.max(0, textLeft));
    textLeft = 0;
    return {
      type: 'text',
      text: `${kept}\n\n[Output truncated: ${Math.round(size / 1024)} KB is more than the 256 KB limit. Ask for less (fewer lines, a filter).]`,
    };
  });
  return { ...parsed.data, content };
}

/** A tool error as a result (the agent sees the message). */
export const toolError = (message: string): McpToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});
