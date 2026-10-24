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
  /** API version, e.g. "0.2.0". */
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
  /** Bounded Code Map reads and source navigation (permission: code-map.read, since 0.2.0). */
  readonly codeMap: CodeMapApi;
}

export interface CodeMapRef {
  projectId: string;
  checkoutId: string;
}
export type CodeMapRelation = 'contains' | 'imports' | 'exports' | 'calls' | 'references' | 'extends' | 'implements';
/** Lines are 1-based; columns are 0-based UTF-16. */
export type CodeMapSpan = [number, number, number, number];
export type CodeMapState = 'disabled' | 'indexing' | 'ready' | 'updating' | 'paused' | 'degraded' | 'error' | 'limit';
export type CodeMapFreshnessMode = 'latest' | 'allow-stale' | 'verified';
export interface CodeMapCoverage {
  files: { indexed: number; unsupported: number; skipped: number; failed: number };
  byLanguage: Record<string, number>;
  unresolved: { imports: number; calls: number };
}
export interface CodeMapFreshness {
  generation: number;
  state: CodeMapState;
  stale: boolean;
  verification: 'metadata' | 'content-hash';
  checkedAt: string | null;
  lastFullHashAt: string | null;
  pendingFiles: number;
  coverage: CodeMapCoverage;
  warnings: string[];
}
export interface CodeMapChange extends CodeMapRef {
  generation: number;
  state: CodeMapState;
}
/** Targeted separately from structural invalidations; requires code-map.knowledge.read (since 0.2.1). */
export interface CodeMapKnowledgeChange extends CodeMapRef {
  memoryRevision: number;
}
export interface CodeMapCheckout extends CodeMapRef {
  label: string;
  mode: 'project' | 'worktree';
}
export interface CodeMapFile {
  id: string;
  path: string;
  group: string;
  language: string;
  bytes: number;
  lines: number;
  sha256: string;
  status: 'ok' | 'syntax-errors' | 'skipped-too-large' | 'unsupported' | 'failed';
  test: boolean;
  stale?: boolean;
}
export interface CodeMapSymbol {
  id: string;
  file: string;
  kind: string;
  name: string;
  owner: string | null;
  exported: boolean;
  signature: string;
  span: CodeMapSpan;
  stale?: boolean;
  visibility?: string;
  buildTags?: string[];
  decorators?: string[];
  parts?: { file: string; span: CodeMapSpan }[];
}
export interface CodeMapEdge {
  from: string;
  to: string;
  rel: CodeMapRelation;
  prov: 'syntax' | 'binding' | 'heuristic';
  at?: [number, number];
  typeOnly?: boolean;
}
export interface CodeMapSliceNode {
  id: string;
  kind: 'file' | 'symbol' | 'group' | 'package' | 'learning' | 'evidence';
  learning?: CodeMapLearning;
  evidence?: { path: string; hash: string };
  label: string;
  path?: string;
  files?: number;
  symbolKind?: string;
  signature?: string;
  span?: CodeMapSpan;
  sha256?: string;
  stale?: boolean;
  whyIncluded: string;
}
export interface CodeMapSliceEdge extends Omit<CodeMapEdge, 'rel' | 'prov'> {
  rel: CodeMapRelation | 'applies_to' | 'supported_by' | 'supersedes' | 'conflicts_with';
  prov: 'syntax' | 'binding' | 'heuristic' | 'knowledge';
  count?: number;
  whyIncluded: string;
}
export interface CodeMapSlice {
  kind: 'slice';
  view: 'overview' | 'file' | 'neighborhood' | 'impact' | 'knowledge' | 'context-receipt';
  memoryRevision?: number;
  receipt?: string;
  receiptExpiresAt?: string;
  nodes: CodeMapSliceNode[];
  edges: CodeMapSliceEdge[];
  visitedNodes: number;
  visitedEdges: number;
  exhaustive: false;
}
/** Reference data, never instructions or a semantic truth score. Since 0.2.1. */
export interface CodeMapLearning {
  id: string;
  revision: number;
  kind: 'constraint' | 'decision' | 'pitfall' | 'validation' | 'failed-approach';
  title: string;
  body: string;
  rationale: string;
  topic?: string;
  replaces?: string;
  projectId: string;
  checkoutId: string;
  scope: 'checkout' | 'project';
  createdAt: string;
  updatedAt: string;
  origin: { source: 'user' | 'agent'; role?: string; task?: string };
  editor?: { source: 'user' | 'agent'; role?: string; task?: string };
  reviewer?: { source: 'user' | 'agent'; role?: string; task?: string };
  review: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  admission?: 'pending' | 'reviewed' | 'automatic';
  reviewedAt?: string;
  evidence: { path: string; hash: string; symbolId?: string; span?: CodeMapSpan }[];
  applicability: { state: 'current' | 'needs-review' | 'archived'; checkedAt: string; reason: string };
  whyIncluded: string;
}
export interface CodeMapSearchMatch {
  id: string;
  path: string;
  name: string;
  kind: string;
  signature?: string;
  span?: CodeMapSpan;
  stale: boolean;
  score: number;
  whyIncluded: string[];
}
export interface CodeMapStatus {
  checkoutId: string;
  state: CodeMapState;
  generation: number;
  counts: { files: number; symbols: number; edges: number };
  coverage: CodeMapCoverage;
  languages: Record<string, { level: 'Files' | 'Symbols' | 'Imports' | 'Calls'; description: string }>;
  progress: { completed: number; total: number } | null;
  updatedAt: string | null;
  bytes: number;
  pendingFiles: number;
  readOnly: boolean;
  gitIgnored?: boolean;
  limits: { files: number; symbols: number; edges: number; bytes: number };
}
export type CodeMapData =
  | CodeMapSlice
  | { kind: 'search'; matches: CodeMapSearchMatch[]; coverage?: number; strong?: boolean }
  | { kind: 'outline'; file: CodeMapFile; definitions: CodeMapSymbol[]; imports: CodeMapEdge[] }
  | { kind: 'status'; status: CodeMapStatus }
  | { kind: 'repo-map'; markdown: string }
  | {
      kind: 'relations';
      nodes: (
        | { kind: 'file'; value: CodeMapFile; whyIncluded: string }
        | { kind: 'symbol'; value: CodeMapSymbol; whyIncluded: string }
        | {
            kind: 'group';
            value: {
              id: string;
              path: string;
              parent?: string | null;
              files: number;
              kind?: 'project' | 'solution';
              name?: string;
            };
            whyIncluded: string;
          }
        | {
            kind: 'package';
            value: { id: string; name: string; external: boolean; ecosystem?: 'npm' | 'nuget' };
            whyIncluded: string;
          }
      )[];
      edges: (CodeMapEdge & { whyIncluded: string })[];
      visitedNodes: number;
      visitedEdges: number;
      exhaustive: false;
    };
export interface CodeMapResponse {
  checkoutId: string;
  code:
    | 'OK'
    | 'INDEX_UPDATING'
    | 'INDEX_PAUSED'
    | 'INDEX_UNAVAILABLE'
    | 'NOT_FOUND'
    | 'BUDGET'
    | 'SNAPSHOT_CHANGED'
    | 'RECEIPT_EXPIRED'
    | 'MEMORY_OFF'
    | 'MEMORY_UNAVAILABLE';
  freshness: CodeMapFreshness;
  data?: CodeMapData;
  truncated: boolean;
  reasons: string[];
  hint: string;
}
export interface CodeMapQueryOptions {
  freshness?: CodeMapFreshnessMode;
  maxChars?: number;
}
export interface CodeMapTraversal {
  direction?: 'incoming' | 'outgoing' | 'both';
  relations?: CodeMapRelation[];
  depth?: number;
  includeHeuristic?: boolean;
}
export type CodeMapRequest = CodeMapRef &
  (
    | ({ kind: 'search'; query: string; pathPrefix?: string; limit?: number } & CodeMapQueryOptions)
    | ({ kind: 'outline'; path: string } & CodeMapQueryOptions)
    | ({ kind: 'relations'; path?: string; symbolId?: string } & CodeMapTraversal & CodeMapQueryOptions)
    | ({
        kind: 'slice';
        view: 'overview' | 'file' | 'neighborhood' | 'impact' | 'knowledge' | 'context-receipt';
        /** Knowledge/receipt slices require both code-map.read and code-map.knowledge.read. */
        learningState?: 'active' | 'pending' | 'stale' | 'all';
        receipt?: string;
        /** Multi-file impact, at most 500 checkout-relative paths. Mutually exclusive with root. */
        paths?: string[];
        root?: { path: string } | { symbolId: string };
        pathPrefix?: string;
        generation?: number;
        maxNodes?: number;
        maxEdges?: number;
        freshness?: CodeMapFreshnessMode;
      } & CodeMapTraversal)
  );
export interface CodeMapLocator extends CodeMapRef {
  path: string;
  generation: number;
  sha256: string;
  symbolId?: string;
  span?: CodeMapSpan;
}
export interface CodeMapApi {
  listCheckouts(projectId: string): Promise<CodeMapCheckout[]>;
  status(ref: CodeMapRef): Promise<CodeMapResponse>;
  query(request: CodeMapRequest, options?: { signal?: AbortSignal }): Promise<CodeMapResponse>;
  onDidChange: Event<CodeMapChange>;
  onDidChangeKnowledge: Event<CodeMapKnowledgeChange>;
  /** Validates current generation, file hash, containment and range before opening the editor. */
  openSource(locator: CodeMapLocator): Promise<void>;
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
  /**
   * Claude Code, Codex CLI and Gemini CLI: the account the agent runs on — `main` (the CLI's default folder) or the
   * id of an account added in Settings → AI Agents (see `listAccounts`). Since API 0.1.7.
   */
  accountId?: string;
}

/** An account of an agent CLI: the main one (the CLI's default folder) or one added in Settings → AI Agents. */
export interface AgentAccount {
  /** `main` or the added account's id. Unique together with `agent`. */
  id: string;
  agent: 'claude' | 'codex' | 'gemini';
  /** `main`, or the name the user gave the account ("Work"). */
  name: string;
  main: boolean;
  /** The account's folder: CLAUDE_CONFIG_DIR, CODEX_HOME or GEMINI_CLI_HOME (resolved for the main account too). */
  home: string;
}

/** A plan limit window of an account (Claude Code: `five_hour`, `seven_day`; Codex CLI: `primary`, `secondary`). */
export interface AgentLimitWindow {
  window: string;
  /** 0–100 (may exceed 100 when the agent reports so). */
  usedPercent: number;
  /** 300: five hours, 10080: a week; null: not time-based. */
  windowMinutes: number | null;
  /** When the window starts over (ms since the epoch); null: unknown. A past value means it is at 0 again. */
  resetsAt: number | null;
  /** When the agent reported it (ms since the epoch). */
  observedAt: number;
}
export interface AgentLimits {
  agent: 'claude' | 'codex' | 'gemini';
  accountId: string;
  windows: AgentLimitWindow[];
}

/** The visible choices from + > AI Agents. Since API 0.1.8. */
export interface AgentLauncher {
  launchId: string;
  name: string;
  detail?: string;
  kind: 'agent' | 'profile' | 'account';
  /** The CLI it starts: `claude`, `codex`, `gemini`… (API profiles run Claude Code). Since API 0.1.10. */
  agent: string;
}
export interface AgentLaunchRequest {
  projectId: string;
  launchId: string;
  terminalId?: string;
  prompt?: string;
  /** false opens a fresh session unless terminalId explicitly selects one. Default true. */
  reuse?: boolean;
  /** Claude Code only, for new sessions. Existing sessions keep their current mode. */
  planMode?: boolean;
  /**
   * Claude Code only, for new sessions: arguments added to the configured launch command, quoted for the terminal's
   * shell (e.g. `['--settings', file]`). At most 16, no control characters. Since API 0.1.10.
   */
  claudeArgs?: string[];
  /** Environment variables of a new session's terminal (at most 16). Reused sessions keep theirs. Since API 0.1.10. */
  env?: Record<string, string>;
  /**
   * Directories a new session may read and write besides the project (at most 8): `--add-dir` for Claude Code and
   * Codex CLI, `--include-directories` for Gemini CLI and Qwen Code. Reused sessions keep theirs. Since API 0.2.2.
   */
  addDirs?: string[];
}
export interface AgentLaunchResult {
  terminalId: string;
  reused: boolean;
  sent: boolean;
  error?: string;
}
export interface AgentsApi {
  /** agents.read ? same choices as + > AI Agents; no credentials. Since API 0.1.8. */
  listLaunchers(): Promise<AgentLauncher[]>;
  /**
   * agents.read + terminals.create + terminals.write ? reuses a matching session or opens an ordinary terminal.
   * Reveals and focuses the terminal in its project's workspace (since API 0.1.9).
   * Sends the optional prompt only when ready; inspect sent/error and let the user retry if it is busy or waiting.
   * A new session of Claude Code, Codex CLI, Gemini CLI or Qwen Code receives a one-line prompt (up to 2000
   * characters) as an argument of its command line instead: it starts with the prompt and `sent` is true at once
   * (since API 0.2.2).
   * terminalId explicitly selects a running session of this profile and project. Since API 0.1.8.
   */
  launch(options: AgentLaunchRequest): Promise<AgentLaunchResult>;
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
  /** The main account of Claude Code, Codex CLI and Gemini CLI and the accounts added next to them. Since API 0.1.7. */
  listAccounts(): Promise<AgentAccount[]>;
  /** Since API 0.1.7. */
  onDidChangeAccounts: Event<AgentAccount[]>;
  /**
   * The latest plan limits of each account, as reported by a plugin that reads them (the Usage Monitor). Accounts
   * without readings are missing. Since API 0.1.7.
   */
  getLimits(): Promise<AgentLimits[]>;
  /** Since API 0.1.7. */
  onDidChangeLimits: Event<AgentLimits[]>;
  /**
   * agents.annotate — reports the plan limits of an account; windows not mentioned keep their last reading, older
   * readings of a window are ignored. Since API 0.1.7.
   */
  reportLimits(limits: AgentLimits): void;
  /**
   * terminals.write — types a prompt into the agent of a terminal and submits it, only while the agent waits for
   * input (idle) and no question (trust, login, yes/no) is on screen; resolves once the agent started working, or with
   * the reason it was not sent. Slash commands are refused. `pasted`: the text reached the agent's input box but it
   * did not start working (do not send it again; since API 0.2.2). Since API 0.1.7.
   */
  sendPrompt(terminalId: string, text: string): Promise<{ ok: true } | { ok: false; error: string; pasted?: boolean }>;
}

// ── Git ─────────────────────────────────────────────────── (git.read)
export interface RepoStatusLite {
  projectId: string;
  branch?: string;
  files: { path: string; status: string; additions?: number; deletions?: number }[];
}
export interface GitApi {
  getStatus(projectId: string): Promise<RepoStatusLite | undefined>;
  /** Requires git.read and code-map.read. Worktrees compare with their recorded Ensemble base. */
  getCheckoutChanges(ref: CodeMapRef): Promise<GitCheckoutChanges>;
  onDidChangeStatus: Event<RepoStatusLite>;
}
export interface GitCheckoutChanges extends CodeMapRef {
  comparison: 'head' | 'worktree-base';
  baseCommit?: string;
  files: { path: string; oldPath?: string; status: string }[];
  total: number;
  truncated: boolean;
}

// ── UI ───────────────────────────────────────────────────
export interface UiApi {
  /** viewId from contributes.views */
  registerViewProvider(viewId: string, provider: ViewProvider): Disposable;
  /** panelType from contributes.panels */
  registerPanelProvider(panelType: string, provider: ViewProvider): Disposable;
  /**
   * With placement: 'sidebar' (since API 0.1.9), opens a right-sidebar tool following the active project,
   * without view.projectId. Reveals a matching singleton in either sidebar or the active workspace instead.
   */
  openPanel(
    panelType: string,
    o?: {
      projectId?: string;
      params?: unknown;
      title?: Localized;
      placement?: 'active-group' | 'right' | 'below' | 'sidebar';
    },
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
