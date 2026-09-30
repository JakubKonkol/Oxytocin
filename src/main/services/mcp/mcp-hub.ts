import { randomBytes } from 'node:crypto';
import {
  MCP_DEFAULT_PORT,
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_SERVER_NAME,
  type McpCallContext,
  type McpCallLogEntry,
  type McpCallOutcome,
  type McpCliResult,
  type McpPolicy,
  type McpState,
  type McpToolResult,
  normalizeToolResult,
  toolError,
} from '@shared/domain/mcp';
import type { Settings } from '@shared/domain/settings';
import type { Logger } from '@shared/logging/logger';
import { type Disposable, DisposableStore } from '@shared/utils/disposable';
import { Emitter } from '@shared/utils/emitter';
import { type CallerDeps, resolveCaller, type ResolvedCaller } from './caller-context';
import {
  addCommandLine,
  type ConnectResult,
  connectClaude,
  disconnectClaude,
  isConnectedToClaude,
  mcpConfigJson,
  mcpUrl,
  type RunCli,
} from './client-registration';
import { buildCoreTools, type CoreTool, type CoreToolsDeps } from './core-tools';
import { type ListedTool, McpHttpServer, type ToolCall } from './http-server';
import { McpToolRegistry, type PluginToolSource, type RegistryEntry } from './tool-registry';

const LOG_LIMIT = 200;
const NOTIFY_DEBOUNCE_MS = 200;
const STATE_DEBOUNCE_MS = 100;

export interface AskPolicyRequest {
  toolTitle: string;
  toolName: string;
  source: string;
  caller: string | undefined;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

/** The user's answer to a tool with the `ask` policy (null: no answer in time, or the window is gone). */
export type AskPolicyAnswer = 'once' | 'always' | 'deny' | null;

export interface McpHubDeps {
  settings(): Settings;
  onDidChangeSettings(listener: (settings: Settings) => void): Disposable;
  updateSettings(patch: Record<string, unknown>): Promise<unknown>;
  /** The server's token, kept in userData (never logged). */
  tokenStore: { get(): string | undefined; set(token: string): Promise<void> };
  appVersion: string;
  core: Omit<CoreToolsDeps, 'tools'>;
  caller: CallerDeps;
  /** A terminal's title and project name for the call log. */
  describeTerminal(id: string): string | undefined;
  plugins: {
    /** Plugins that declare `contributes.mcp`. */
    sources(): PluginToolSource[];
    onDidChange(listener: () => void): Disposable;
    /** Runs a plugin tool in its Plugin Host (activating the plugin first). */
    call(o: {
      pluginId: string;
      name: string;
      args: Record<string, unknown>;
      context: McpCallContext;
      timeoutMs: number;
      signal: AbortSignal;
    }): Promise<McpToolResult>;
    /** Shows a visible problem for plugins that lost their tool prefix to another plugin. */
    setProblems(problems: Map<string, string>): void;
  };
  askPolicy(request: AskPolicyRequest): Promise<AskPolicyAnswer>;
  cli: RunCli;
  logger: Logger;
}

const INSTRUCTIONS =
  'Oxytocin is the desktop app the user runs you in: it manages their projects, terminals (shells, dev servers, other agents), git changes and plugins. Use these tools to see what runs in the other terminals, to show the user a file, to notify or ask them. Tools that take `cwd` choose the Oxytocin project that contains it; pass your working directory. Plugins add tools while you work; `oxy_capabilities` lists the current ones.';

/**
 * Oxytocin's MCP server: one local server (`oxytocin`) with core tools and the tools plugins contribute. Agents learn
 * about added or removed tools through `notifications/tools/list_changed`.
 */
export class McpHub implements Disposable {
  private readonly store = new DisposableStore();
  readonly registry = new McpToolRegistry();
  private readonly server: McpHttpServer;
  private readonly coreTools: Map<string, CoreTool>;
  private readonly log: McpCallLogEntry[] = [];
  private logId = 0;
  private claudeConnected: boolean | null = null;
  /** The port the running server was started for (the setting; 0 picks a free port in tests). */
  private startedFor: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private lastListedKey: string;
  private lastProblems = '';
  private readonly stateEmitter = new Emitter<McpState>();
  /** Status, tools or the call log changed (debounced). */
  readonly onDidChangeState = this.stateEmitter.event;
  private disposed = false;

  constructor(private readonly deps: McpHubDeps) {
    this.server = new McpHttpServer(
      {
        info: () => ({ name: MCP_SERVER_NAME, version: deps.appVersion, instructions: this.instructions() }),
        listTools: () => this.listTools(),
        hasTool: (name) => this.registry.resolve(name) !== undefined,
        callTool: (name, args, call) => this.callTool(name, args, call),
      },
      () => this.token(),
    );
    const core = buildCoreTools({ ...deps.core, tools: () => this.registry.all() });
    this.coreTools = new Map(core.map((t) => [t.definition.name, t]));
    const defaults: Record<string, McpPolicy> = {};
    for (const t of core) if (t.defaultPolicy) defaults[t.definition.name] = t.defaultPolicy;
    this.registry.setCore(
      core.map((t) => t.definition),
      defaults,
    );
    this.applyToolSettings(deps.settings());
    this.registry.setPlugins(deps.plugins.sources());
    this.lastListedKey = this.registry.listedKey();
    this.store.add(this.registry.onDidChange(() => this.onRegistryChange()));
    this.store.add(this.server.onDidChangeSessions(() => this.scheduleState()));
    this.store.add(deps.plugins.onDidChange(() => this.registry.setPlugins(deps.plugins.sources())));
    let serverKey = this.serverKey(deps.settings());
    this.store.add(
      deps.onDidChangeSettings((s) => {
        this.applyToolSettings(s);
        const key = this.serverKey(s);
        if (key !== serverKey) {
          serverKey = key;
          void this.apply();
        }
      }),
    );
  }

  // ── lifecycle ──

  start(): Promise<void> {
    return this.apply();
  }

  private serverKey(s: Settings): string {
    return JSON.stringify([s['mcp.enabled'], s['mcp.port']]);
  }

  private port(): number {
    return this.deps.settings()['mcp.port'] ?? MCP_DEFAULT_PORT;
  }

  /** Starts, moves or stops the server per the settings; serialized (quick toggles must not overlap). */
  private apply(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      if (!this.deps.settings()['mcp.enabled']) {
        await this.server.stop();
        this.startedFor = null;
        this.server.error = null;
      } else if (this.server.port === null || this.startedFor !== this.port()) {
        this.token();
        this.startedFor = this.port();
        await this.server.start(this.port()).catch((e: unknown) => {
          this.deps.logger.warn(`The MCP server could not start: ${this.server.error ?? String(e)}`);
        });
        if (this.server.port !== null) this.deps.logger.info(`MCP server listening on ${mcpUrl(this.server.port)}`);
      }
      this.scheduleState();
    });
    return this.queue;
  }

  async stop(): Promise<void> {
    await this.queue;
    this.startedFor = null;
    await this.server.stop();
  }

  // ── token ──

  private token(): string {
    let token = this.deps.tokenStore.get();
    if (!token) {
      token = randomBytes(24).toString('base64url');
      void this.deps.tokenStore
        .set(token)
        .catch((e: unknown) => this.deps.logger.warn('Saving the MCP token failed', e));
    }
    return token;
  }

  /** A new token: connected clients must be registered again (done for Claude Code when it was connected). */
  async resetToken(): Promise<ConnectResult | null> {
    await this.deps.tokenStore.set(randomBytes(24).toString('base64url'));
    // Sessions opened with the old token end; their next request fails with 401.
    await this.server.stop();
    await this.apply();
    const reconnect = this.claudeConnected === true ? await this.connectClaude() : null;
    this.scheduleState();
    return reconnect;
  }

  // ── tools ──

  private applyToolSettings(s: Settings): void {
    this.registry.setSettings({ disabled: s['mcp.tools.disabled'], policies: s['mcp.tools.policy'] });
  }

  private listTools(): ListedTool[] {
    return this.registry.listed().map((e) => ({
      name: e.name,
      ...(e.definition.title ? { title: e.definition.title } : {}),
      description: e.definition.description,
      inputSchema: e.definition.inputSchema,
      ...(e.definition.annotations ? { annotations: e.definition.annotations } : {}),
    }));
  }

  private instructions(): string {
    const plugins = new Map<string, number>();
    for (const e of this.registry.listed())
      if (e.source.kind === 'plugin') plugins.set(e.source.pluginName, (plugins.get(e.source.pluginName) ?? 0) + 1);
    if (plugins.size === 0) return INSTRUCTIONS;
    const lines = [...plugins].map(([name, n]) => `- ${name}: ${n} tool${n === 1 ? '' : 's'}`);
    return `${INSTRUCTIONS}\n\nPlugins with tools now:\n${lines.join('\n')}`;
  }

  private onRegistryChange(): void {
    const problems = this.registry.problems();
    const problemsKey = JSON.stringify([...problems]);
    if (problemsKey !== this.lastProblems) {
      this.lastProblems = problemsKey;
      this.deps.plugins.setProblems(problems);
    }
    this.scheduleState();
    // A plugin reload removes and adds its tools: one notification, and none when nothing changed after all.
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => {
      const key = this.registry.listedKey();
      if (key === this.lastListedKey) return;
      this.lastListedKey = key;
      const clients = this.server.notifyToolsChanged();
      this.deps.logger.debug(`MCP tool list changed; notified ${clients} client(s)`);
    }, NOTIFY_DEBOUNCE_MS);
  }

  addDynamicTool(pluginId: string, definition: unknown): void {
    this.registry.addDynamic(pluginId, definition);
  }

  removeDynamicTool(pluginId: string, name: string): void {
    this.registry.removeDynamic(pluginId, name);
  }

  /** The Plugin Host of these plugins restarted: their runtime tools are gone (declared ones stay listed). */
  dropDynamicTools(pluginIds: Iterable<string>): void {
    this.registry.dropDynamic(pluginIds);
  }

  // ── calls ──

  private sourceLabel(entry: RegistryEntry): string {
    return entry.source.kind === 'core' ? 'Oxytocin' : entry.source.pluginName;
  }

  private callerLabel(caller: ResolvedCaller): string | undefined {
    const terminal = caller.context.terminalId ? this.deps.describeTerminal(caller.context.terminalId) : undefined;
    return terminal ?? caller.label;
  }

  private record(entry: Omit<McpCallLogEntry, 'id'>): void {
    this.log.push({ ...entry, id: ++this.logId });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.scheduleState();
  }

  async callTool(name: string, args: Record<string, unknown>, call: ToolCall): Promise<McpToolResult> {
    const entry = this.registry.resolve(name);
    if (!entry) return toolError(`The tool ${name} is not available.`);
    const started = Date.now();
    const caller = await resolveCaller(this.deps.caller, {
      ...(call.terminalHeader ? { terminalHeader: call.terminalHeader } : {}),
      args,
    });
    const callerLabel = this.callerLabel(caller);
    const finish = (outcome: McpCallOutcome, result: McpToolResult, error?: string): McpToolResult => {
      this.record({
        at: started,
        tool: name,
        source: this.sourceLabel(entry),
        ...(callerLabel ? { caller: callerLabel } : {}),
        durationMs: Date.now() - started,
        outcome,
        ...(error ? { error: error.slice(0, 300) } : {}),
      });
      return result;
    };
    const timeoutMs = entry.definition.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const abort = () => controller.abort();
    call.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      if (entry.policy === 'ask') {
        const answer = await this.deps.askPolicy({
          toolTitle: entry.definition.title ?? entry.name,
          toolName: entry.name,
          source: this.sourceLabel(entry),
          caller: callerLabel,
          args,
          signal: controller.signal,
        });
        if (answer === 'always') await this.setPolicy(entry.name, 'allow');
        if (answer !== 'once' && answer !== 'always') {
          const message =
            answer === 'deny'
              ? `The user did not allow ${name} this time.`
              : `${name} needs the user's permission, and nobody answered in time.`;
          return finish('denied', toolError(message), answer === 'deny' ? 'Denied by the user' : 'No answer');
        }
      }
      const run = this.run(entry, args, caller, call.sessionId, controller.signal, timeoutMs);
      const aborted = new Promise<'aborted'>((resolve) => {
        if (controller.signal.aborted) resolve('aborted');
        else controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const result = await Promise.race([run, aborted]);
      if (result === 'aborted') {
        run.catch(() => undefined);
        if (call.signal.aborted) return finish('cancelled', toolError('Cancelled.'), 'Cancelled by the agent');
        const message = `${name} did not finish within ${Math.round(timeoutMs / 1000)} s.`;
        return finish('error', toolError(message), message);
      }
      const normalized = normalizeToolResult(result);
      const text = normalized.isError
        ? normalized.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text
        : undefined;
      return finish(normalized.isError ? 'error' : 'ok', normalized, text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return finish('error', toolError(message), message);
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener('abort', abort);
    }
  }

  private async run(
    entry: RegistryEntry,
    args: Record<string, unknown>,
    caller: ResolvedCaller,
    sessionId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<McpToolResult | string> {
    if (entry.source.kind === 'core') {
      const tool = this.coreTools.get(entry.name);
      if (!tool) throw new Error(`The tool ${entry.name} is not available.`);
      return tool.run({ args, caller, sessionId, signal });
    }
    return this.deps.plugins.call({
      pluginId: entry.source.pluginId,
      name: entry.name,
      args,
      context: caller.context,
      timeoutMs,
      signal,
    });
  }

  // ── settings UI ──

  async setPolicy(name: string, policy: McpPolicy | null): Promise<void> {
    const current = { ...this.deps.settings()['mcp.tools.policy'] };
    if (policy === null) delete current[name];
    else current[name] = policy;
    await this.deps.updateSettings({ 'mcp.tools.policy': current });
  }

  state(): McpState {
    const port = this.server.port;
    return {
      status: {
        enabled: this.deps.settings()['mcp.enabled'],
        port,
        url: mcpUrl(port ?? this.port()),
        error: this.server.error,
        sessions: this.server.sessionCount,
        claudeConnected: this.claudeConnected,
        calls: this.server.calls,
      },
      tools: this.registry.all(),
      log: [...this.log].reverse(),
    };
  }

  private scheduleState(): void {
    if (this.stateTimer || this.disposed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      if (!this.disposed) this.stateEmitter.fire(this.state());
    }, STATE_DEBOUNCE_MS);
  }

  clearLog(): void {
    this.log.length = 0;
    this.scheduleState();
  }

  // ── clients ──

  async checkClaude(): Promise<boolean | null> {
    this.claudeConnected = await isConnectedToClaude(this.deps.cli, this.server.port ?? this.port());
    this.scheduleState();
    return this.claudeConnected;
  }

  async connectClaude(): Promise<ConnectResult> {
    await this.queue;
    const port = this.server.port;
    if (port === null)
      return {
        ok: false,
        output: this.server.error ?? 'The MCP server is turned off ("mcp.enabled" in Settings).',
        migrated: false,
      };
    const result = await connectClaude(this.deps.cli, port, this.token());
    if (result.ok) this.claudeConnected = true;
    if (result.migrated) this.deps.logger.info('Removed the old "oxytocin-runner" MCP server from Claude Code');
    this.scheduleState();
    return result;
  }

  async disconnectClaude(): Promise<McpCliResult> {
    const result = await disconnectClaude(this.deps.cli);
    if (result.ok) this.claudeConnected = false;
    this.scheduleState();
    return result;
  }

  /** The Claude Code command line and the `mcpServers` JSON for other clients (with the token). */
  clientConfig(): { command: string; json: string } {
    const port = this.server.port ?? this.port();
    return { command: addCommandLine(port, this.token()), json: mcpConfigJson(port, this.token()) };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.notifyTimer);
    clearTimeout(this.stateTimer);
    this.store.dispose();
    this.registry.dispose();
    this.stateEmitter.dispose();
    void this.server.dispose();
  }
}
