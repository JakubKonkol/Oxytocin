import {
  CORE_TOOL_PREFIX,
  defaultPolicy,
  type McpPolicy,
  type McpToolDefinition,
  McpToolDefinitionSchema,
  type McpToolInfo,
  type McpToolSource,
} from '@shared/domain/mcp';
import { Emitter } from '@shared/utils/emitter';

/** What the registry knows about a plugin that contributes tools (`contributes.mcp`). */
export interface PluginToolSource {
  pluginId: string;
  pluginName: string;
  builtin: boolean;
  prefix: string;
  /** Tools declared in the manifest (listed before the plugin is activated). */
  declared: McpToolDefinition[];
  /** Enabled, consented (it has the `mcp.tools` permission) and not failed. */
  available: boolean;
  /** Why it is not available (shown next to its tools). */
  unavailableReason?: string;
}

export interface RegistryEntry {
  name: string;
  definition: McpToolDefinition;
  source: McpToolSource;
  policy: McpPolicy;
  /** Registered at runtime (`oxy.mcp.registerTool(definition, …)`), not in the manifest. */
  dynamic: boolean;
}

export interface ToolSettings {
  disabled: readonly string[];
  policies: Readonly<Record<string, McpPolicy>>;
}

const MAX_DYNAMIC_TOOLS = 100;

/**
 * The set of tools Oxytocin's MCP server offers: core tools plus plugin contributions, filtered by the user's
 * settings. Pure (no I/O, no timers) so every listing rule is unit-testable.
 *
 * A tool is listed when its source is the core or an available plugin, its name is valid and not taken, the user did
 * not turn it off and its policy is not `deny`. When two plugins claim a prefix, a built-in plugin wins (then the
 * lower id); the other one's tools are not listed and it gets a problem.
 */
export class McpToolRegistry {
  private core: McpToolDefinition[] = [];
  private coreDefaults: Readonly<Record<string, McpPolicy>> = {};
  private plugins: PluginToolSource[] = [];
  private readonly dynamic = new Map<string, McpToolDefinition[]>();
  private settings: ToolSettings = { disabled: [], policies: {} };
  private readonly changeEmitter = new Emitter<void>();
  /** Anything changed (the hub debounces and compares `listedKey()`). */
  readonly onDidChange = this.changeEmitter.event;

  /** Core tools; `defaults` overrides the default policy of some of them. */
  setCore(tools: McpToolDefinition[], defaults: Readonly<Record<string, McpPolicy>> = {}): void {
    this.core = tools;
    this.coreDefaults = defaults;
    this.changeEmitter.fire();
  }

  setPlugins(sources: PluginToolSource[]): void {
    this.plugins = sources;
    for (const id of [...this.dynamic.keys()]) if (!sources.some((s) => s.pluginId === id)) this.dynamic.delete(id);
    this.changeEmitter.fire();
  }

  setSettings(settings: ToolSettings): void {
    this.settings = settings;
    this.changeEmitter.fire();
  }

  /** Adds (or replaces) a tool a plugin registered at runtime; throws when it is not allowed. */
  addDynamic(pluginId: string, definition: unknown): McpToolDefinition {
    const source = this.plugins.find((p) => p.pluginId === pluginId);
    if (!source) throw new Error(`Plugin ${pluginId} does not declare contributes.mcp`);
    const parsed = McpToolDefinitionSchema.safeParse(definition);
    if (!parsed.success) throw new Error(`Invalid tool definition: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    const tool = parsed.data;
    if (!tool.name.startsWith(`${source.prefix}_`))
      throw new Error(`Tool "${tool.name}" must start with the plugin's prefix "${source.prefix}_"`);
    if (source.declared.some((t) => t.name === tool.name))
      throw new Error(`Tool "${tool.name}" is declared in the manifest; register only its handler`);
    const list = (this.dynamic.get(pluginId) ?? []).filter((t) => t.name !== tool.name);
    if (list.length >= MAX_DYNAMIC_TOOLS) throw new Error(`A plugin can add at most ${MAX_DYNAMIC_TOOLS} tools`);
    this.dynamic.set(pluginId, [...list, tool]);
    this.changeEmitter.fire();
    return tool;
  }

  removeDynamic(pluginId: string, name?: string): void {
    const list = this.dynamic.get(pluginId);
    if (!list) return;
    const next = name === undefined ? [] : list.filter((t) => t.name !== name);
    if (next.length === list.length) return;
    if (next.length > 0) this.dynamic.set(pluginId, next);
    else this.dynamic.delete(pluginId);
    this.changeEmitter.fire();
  }

  /** Drops the runtime tools of the given plugins (their Plugin Host restarted). */
  dropDynamic(pluginIds: Iterable<string>): void {
    let changed = false;
    for (const id of pluginIds) changed = this.dynamic.delete(id) || changed;
    if (changed) this.changeEmitter.fire();
  }

  private defaultOf(tool: McpToolDefinition, core: boolean): McpPolicy {
    return (core ? this.coreDefaults[tool.name] : undefined) ?? defaultPolicy(tool.annotations);
  }

  /** Prefix owner per prefix, and the problem of every plugin that lost its prefix. */
  private prefixes(): { owners: Map<string, string>; problems: Map<string, string> } {
    const owners = new Map<string, string>();
    const problems = new Map<string, string>();
    const contenders = this.plugins
      .filter((p) => p.available)
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.pluginId.localeCompare(b.pluginId));
    for (const p of contenders) {
      const owner = owners.get(p.prefix);
      if (owner === undefined) owners.set(p.prefix, p.pluginId);
      else
        problems.set(
          p.pluginId,
          `The MCP tool prefix "${p.prefix}" is already used by ${this.plugins.find((x) => x.pluginId === owner)?.pluginName ?? owner}; its tools are not offered.`,
        );
    }
    return { owners, problems };
  }

  /** Plugins whose tools are not offered because another plugin owns their prefix. */
  problems(): Map<string, string> {
    return this.prefixes().problems;
  }

  /** Every tool with its state, core first, then by plugin and name. */
  all(): McpToolInfo[] {
    return this.compute().infos;
  }

  /** The tools agents see, sorted by name. */
  listed(): RegistryEntry[] {
    return [...this.compute().listed.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A listed tool by name. */
  resolve(name: string): RegistryEntry | undefined {
    return this.compute().listed.get(name);
  }

  private compute(): { infos: McpToolInfo[]; listed: Map<string, RegistryEntry> } {
    const { owners, problems } = this.prefixes();
    const disabled = new Set(this.settings.disabled);
    const listed = new Map<string, RegistryEntry>();
    const taken = new Set<string>();
    const infos: McpToolInfo[] = [];
    const add = (tool: McpToolDefinition, source: McpToolSource, dynamic: boolean, problem: string | undefined) => {
      const fallback = this.defaultOf(tool, source.kind === 'core');
      const reason = problem ?? (taken.has(tool.name) ? `Another tool is already named "${tool.name}".` : undefined);
      if (!reason) taken.add(tool.name);
      const policy = this.settings.policies[tool.name] ?? fallback;
      const enabled = !disabled.has(tool.name);
      const isListed = !reason && enabled && policy !== 'deny';
      if (isListed) listed.set(tool.name, { name: tool.name, definition: tool, source, policy, dynamic });
      infos.push({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        source,
        enabled,
        policy,
        defaultPolicy: fallback,
        listed: isListed,
        ...(reason ? { problem: reason } : {}),
      });
    };
    for (const tool of this.core) add(tool, { kind: 'core' }, false, undefined);
    const plugins = [...this.plugins].sort(
      (a, b) => a.pluginName.localeCompare(b.pluginName) || a.pluginId.localeCompare(b.pluginId),
    );
    for (const p of plugins) {
      const source: McpToolSource = { kind: 'plugin', pluginId: p.pluginId, pluginName: p.pluginName };
      const problem = !p.available
        ? (p.unavailableReason ?? 'The plugin is turned off.')
        : p.prefix === CORE_TOOL_PREFIX
          ? `The prefix "${CORE_TOOL_PREFIX}" is reserved.`
          : owners.get(p.prefix) !== p.pluginId
            ? problems.get(p.pluginId)
            : undefined;
      const tools = [
        ...p.declared.map((t) => ({ t, dynamic: false })),
        ...(this.dynamic.get(p.pluginId) ?? []).map((t) => ({ t, dynamic: true })),
      ].sort((a, b) => a.t.name.localeCompare(b.t.name));
      for (const { t, dynamic } of tools) add(t, source, dynamic, problem);
    }
    return { infos, listed };
  }

  /** Stable key of what agents see (names, titles, descriptions, schemas): equal keys need no notification. */
  listedKey(): string {
    return JSON.stringify(
      this.listed().map((e) => [
        e.name,
        e.definition.title ?? '',
        e.definition.description,
        e.definition.inputSchema,
        e.definition.annotations ?? null,
      ]),
    );
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
