/**
 * Oxytocin plugin backend API, version 0.1.
 * Breaking changes are allowed in 0.x minor versions and are listed in CHANGELOG.md.
 */

export interface Disposable {
  dispose(): void;
}
export type Event<T> = (listener: (e: T) => unknown) => Disposable;
/** The UI is English-only; kept as an alias so localization could be added without breaking the API. */
export type Localized = string;

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface PluginContext {
  readonly plugin: { id: string; version: string; path: string; builtin: boolean };
  /** Disposed when the plugin is deactivated. */
  readonly subscriptions: Disposable[];
  readonly storage: PluginStorage;
  readonly log: Logger;
  readonly oxy: OxytocinApi;
}

export interface PluginStorage {
  /** userData/plugin-data/<pluginId>/ (created on first use). */
  readonly globalDir: string;
  /** userData/plugin-data/<pluginId>/projects/<projectId>/ (created on first use). */
  projectDir(projectId: string): string;
  /** Small JSON key/value store (≤ 1 MB in total, written atomically). */
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface OxytocinApi {
  /** API version, e.g. "0.1.0". */
  readonly version: string;
  readonly env: {
    appVersion: string;
    platform: 'win32' | 'darwin' | 'linux';
    locale: string;
    homeDir: string;
    userDataDir: string;
  };
  readonly projects: ProjectsApi;
  readonly terminals: TerminalsApi;
  readonly agents: AgentsApi;
  readonly git: GitApi;
  readonly ui: UiApi;
  readonly commands: CommandsApi;
  readonly settings: SettingsApi;
  /** Tools for AI agents through Oxytocin's MCP server (since 0.1.5). */
  readonly mcp: McpApi;
}

// ── Projects ───────────────────────────────────────────── (permission: projects.read)
export interface ProjectInfo {
  id: string;
  name: string;
  rootPath: string;
  /** Palette colour (CSS colour value). */
  color: string;
}
export interface ProjectsApi {
  list(): Promise<ProjectInfo[]>;
  getActive(): Promise<ProjectInfo | undefined>;
  /** Longest matching project root — to attribute a cwd to a project. */
  findByPath(path: string): Promise<ProjectInfo | undefined>;
  onDidChangeActive: Event<ProjectInfo | undefined>;
  onDidChange: Event<ProjectInfo[]>;
}

// ── Terminals ────────────────────────────────────────────
export interface TerminalMeta {
  id: string;
  projectId: string;
  profileId: string;
  title: string;
  pid?: number;
  status: 'starting' | 'running' | 'exited';
  exitCode?: number;
  kind: 'shell' | 'process' | 'agent';
  agentId?: string;
  createdAt: number;
  /** Current working directory (tracked through shell integration). Since API 0.1.4. */
  cwd?: string;
  /** Started with `reveal: false` and not shown yet (it has no panel). Since API 0.1.4. */
  background?: boolean;
  /** Nearest non-shell process, e.g. `node` of `npm run dev`. Since API 0.1.4. */
  foreground?: { pid: number; name: string; commandLine: string };
  /** Shell integration reports command boundaries and exit codes for this terminal. Since API 0.1.4. */
  shellIntegration?: boolean;
  /** The command running now (shell integration). Since API 0.1.4. */
  command?: { commandLine?: string; startedAt: number };
  /** The last finished command (shell integration). Since API 0.1.4. */
  lastCommand?: { commandLine?: string; exitCode?: number; durationMs: number; finishedAt: number };
}
export interface TerminalsApi {
  /** terminals.read-metadata */
  list(filter?: { projectId?: string }): Promise<TerminalMeta[]>;
  onDidOpen: Event<TerminalMeta>;
  onDidClose: Event<{ id: string }>;
  onDidChange: Event<TerminalMeta>;
  /**
   * terminals.create — starts a terminal (the profile's shell; `command` is typed into it once the shell is ready)
   * and opens its panel in the project's workspace. With `reveal: false` it runs in the background without a panel
   * until `show` is called (API 0.1.4). `env` adds variables for this terminal only; `null` removes one (API 0.1.4).
   */
  create(o: {
    projectId: string;
    profileId?: string;
    cwd?: string;
    title?: string;
    command?: string;
    placement?: 'active-group' | 'right' | 'below';
    env?: Record<string, string | null>;
    reveal?: boolean;
  }): Promise<TerminalMeta>;
  /** terminals.write */
  sendText(id: string, text: string, opts?: { addNewLine?: boolean }): Promise<void>;
  /**
   * terminals.read-metadata — shows a terminal: activates its project and its panel, opening one (at `placement`)
   * for a background terminal. `preserveFocus` keeps the keyboard focus where it is. Since API 0.1.4.
   */
  show(id: string, o?: { preserveFocus?: boolean; placement?: 'active-group' | 'right' | 'below' }): Promise<void>;
  /**
   * terminals.write — ends the terminal's process: a graceful kill whose process tree is killed after 3 s, or at
   * once with `force`. The terminal stays (status `exited`) until it is closed. Since API 0.1.4.
   */
  kill(id: string, o?: { force?: boolean }): Promise<void>;
  /** terminals.write — kills the terminal if needed and removes it together with its panel. Since API 0.1.4. */
  close(id: string): Promise<void>;
  /**
   * terminals.read-metadata — TCP ports that the terminal's shell and its descendant processes listen on (e.g. the
   * port of a dev server), ascending. Empty for exited terminals. Since API 0.1.4.
   */
  getListeningPorts(id: string): Promise<number[]>;
  /**
   * terminals.read-output — the raw output of one terminal (VT sequences included), in batches, from the moment of
   * subscribing. Output is streamed to the Plugin Host only while someone listens. Since API 0.1.4.
   */
  onDidWriteData(id: string, listener: (data: string) => void): Disposable;
  /** terminals.env */
  readonly environment: EnvironmentCollection;
}

/** No scope = all terminals; `projectId` = that project's terminals; `profileIds` = only these profiles. */
export interface EnvScope {
  projectId?: string;
  profileIds?: string[];
}
/**
 * Values may contain `${env:NAME}`, expanded against the terminal's already composed environment
 * (e.g. `oxytocin.terminal_id=${env:OXYTOCIN_TERMINAL_ID}`). Missing variables expand to an empty string.
 */
export interface EnvironmentCollection {
  replace(name: string, value: string, scope?: EnvScope): void;
  /** `separator` is inserted only when the variable already has a value (PATH always uses the platform one). */
  append(name: string, value: string, scope?: EnvScope, options?: { separator?: string }): void;
  prepend(name: string, value: string, scope?: EnvScope, options?: { separator?: string }): void;
  delete(name: string, scope?: EnvScope): void;
  clear(): void;
  /** Declares the collection complete (releases the start-up spawn barrier). */
  ready(): void;
  /** Shown in the "environment out of date" tooltip. */
  description?: Localized;
}

// ── Agents ─────────────────────────────────────────────── (agents.read / agents.annotate)
export interface AgentSnapshot {
  terminalId: string;
  projectId: string;
  agentId: string;
  displayName: string;
  provider: string;
  pid: number;
  sessionId?: string;
  state: 'starting' | 'working' | 'idle' | 'waiting' | 'unknown';
  waitingFor?: string;
  since: number;
  cwd?: string;
}
export interface AgentsApi {
  list(): Promise<AgentSnapshot[]>;
  onDidChange: Event<AgentSnapshot[]>;
  /** agents.annotate — a session id found by the plugin (e.g. by correlating Codex/Gemini session files). */
  reportSession(terminalId: string, info: { sessionId: string; source: string }): void;
  /**
   * agents.annotate — the agent's state as reported by the agent itself (e.g. Claude Code hooks). It has the highest
   * priority: other sources cannot override it for 10 s. Ignored when the terminal runs no detected agent.
   * Since API 0.1.2.
   */
  reportState(
    terminalId: string,
    report: { state: 'working' | 'idle' | 'waiting'; waitingFor?: string; sessionId?: string },
  ): void;
}

// ── Git ─────────────────────────────────────────────────── (git.read)
export interface RepoStatusLite {
  projectId: string;
  branch?: string;
  files: { path: string; status: string; additions?: number; deletions?: number }[];
}
export interface GitApi {
  getStatus(projectId: string): Promise<RepoStatusLite | undefined>;
  onDidChangeStatus: Event<RepoStatusLite>;
}

// ── UI ───────────────────────────────────────────────────
export interface UiApi {
  /** viewId from contributes.views */
  registerViewProvider(viewId: string, provider: ViewProvider): Disposable;
  /** panelType from contributes.panels */
  registerPanelProvider(panelType: string, provider: ViewProvider): Disposable;
  openPanel(
    panelType: string,
    o?: { projectId?: string; params?: unknown; title?: Localized; placement?: 'active-group' | 'right' | 'below' },
  ): Promise<void>;
  /** id from contributes.statusBarItems */
  statusBarItem(id: string): StatusBarItem;
  showNotification(o: {
    level: 'info' | 'warning' | 'error';
    message: Localized;
    detail?: string;
    actions?: { id: string; title: Localized }[];
    /** Also as an OS notification (permission notifications.os). */
    os?: boolean;
    /**
     * Withdraws a notification with `actions` (the question was answered elsewhere or no longer applies): it closes
     * and the promise resolves undefined. Since API 0.1.6.
     */
    signal?: AbortSignal;
  }): Promise<string | undefined>;
  /** http/https only */
  openExternal(url: string): Promise<void>;
  openInEditor(path: string, line?: number, column?: number): Promise<void>;
  /**
   * Lets the user pick one item in the command palette (fuzzy filtered). Resolves the chosen item, or
   * undefined when the pick was dismissed. At most 5000 items. Since API 0.1.1.
   */
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[],
    options?: { placeholder?: string },
  ): Promise<T | undefined>;
}
export interface QuickPickItem {
  label: string;
  /** Muted text after the label. */
  description?: string;
  /** Second line under the label. */
  detail?: string;
}
export interface ViewProvider {
  resolve(view: PluginView): void | Promise<void>;
}
export interface PluginView {
  /** Instance id of the view or panel. */
  readonly id: string;
  readonly kind: 'view' | 'panel';
  readonly projectId?: string;
  readonly params?: unknown;
  title?: Localized;
  badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' } | undefined;
  readonly visible: boolean;
  /** Resolves false when the view no longer exists. */
  postMessage(msg: unknown): Promise<boolean>;
  onDidReceiveMessage: Event<unknown>;
  /** Handles `view.request(method, params)` from the view's SDK. */
  onRequest<P, R>(method: string, handler: (params: P) => R | Promise<R>): Disposable;
  onDidChangeVisibility: Event<boolean>;
  onDidDispose: Event<void>;
}
export interface StatusBarItem {
  /** May contain codicons: `$(graph) $4.82`. */
  text: string;
  tooltip?: Localized;
  color?: 'default' | 'success' | 'warning' | 'danger' | 'accent';
  command?: string | { id: string; args?: unknown[] };
  show(): void;
  hide(): void;
  dispose(): void;
}

// ── Commands ─────────────────────────────────────────────
export interface CommandsApi {
  /** id from contributes.commands, or a private id prefixed with the plugin id. */
  register(id: string, handler: (...args: unknown[]) => unknown): Disposable;
  /** Core commands and commands of other plugins. */
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
}

// ── Settings ─────────────────────────────────────────────
export interface SettingsApi {
  /** Keys with the plugin's own prefix, or public core keys (appearance.*). */
  get<T>(key: string): T;
  /** Only keys with the plugin's own prefix. */
  update(key: string, value: unknown): Promise<void>;
  onDidChange(keyPrefix: string, listener: () => void): Disposable;
}

// ── Tools for AI agents ────────────────────────────────── (mcp.tools, since 0.1.5)
/**
 * Plugins give AI agents (Claude Code, Codex CLI, Cursor, …) tools through Oxytocin's MCP server. Declare them in
 * `contributes.mcp` (a `prefix` and the `tools`); every tool name starts with `<prefix>_`. Agents see a tool as soon as
 * the plugin is enabled — calling it activates the plugin with `onMcpTool:<name>`.
 */
export interface McpApi {
  /**
   * Handles a tool declared in `contributes.mcp.tools`. Without a handler, calls to the tool fail with "tool not
   * available". Disposing unregisters the handler.
   */
  registerTool(name: string, handler: McpToolHandler): Disposable;
  /**
   * Adds a tool that is not in the manifest (e.g. only while a database is running). The name must use the plugin's
   * prefix. It is listed while the Disposable lives and the plugin is enabled.
   */
  registerTool(definition: McpToolDefinition, handler: McpToolHandler): Disposable;
}

/** Returns the result, or a string (one text item). A thrown error is reported to the agent as a tool error. */
export type McpToolHandler = (
  args: Record<string, unknown>,
  context: McpCallContext,
) => Promise<McpToolResult | string> | McpToolResult | string;

export interface McpCallContext {
  /** The project the call belongs to (from the caller's terminal, else its cwd/project argument, else the active one). */
  projectId?: string;
  /** The Oxytocin terminal the agent runs in, when known. */
  terminalId?: string;
  agentId?: string;
  /** Aborted when the agent cancels the call, the call times out or the plugin is deactivated. */
  signal: AbortSignal;
}

export interface McpToolDefinition {
  /** `^[a-zA-Z0-9_-]{1,64}$`, starting with the plugin's prefix and "_". */
  name: string;
  title?: string;
  /** Agents choose tools by their description: say what it does and when to use it. */
  description: string;
  /** JSON Schema of the arguments (`type: "object"`). Validate the arguments yourself: they come from an agent. */
  inputSchema: { type: 'object'; [key: string]: unknown };
  /** `destructiveHint: true` makes Oxytocin ask the user before each call (unless they allow it always). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Default 60 000, at most 600 000. */
  timeoutMs?: number;
}

export interface McpToolResult {
  /** Text is cut at 256 KB and images over 5 MB are left out (with a note to the agent). */
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
