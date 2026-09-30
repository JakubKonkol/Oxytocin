import type { McpCallContext, McpToolResult } from '../../domain/mcp';
import type { HostBaseEvents, HostBaseMethods } from './host-base';

/** What the Plugin Host needs to load one plugin. */
export interface HostPluginInfo {
  id: string;
  version: string;
  path: string;
  /** Absolute path of the backend entry (none for view-only plugins). */
  main?: string;
  builtin: boolean;
  permissions: string[];
  activationEvents: string[];
  commands: string[];
  views: string[];
  panels: string[];
  statusBarItems: string[];
  configurationPrefix?: string;
  /** `contributes.mcp.prefix`: tools registered at runtime must start with `<prefix>_`. */
  mcpPrefix?: string;
  /** Names of the tools declared in `contributes.mcp.tools`. */
  mcpTools: string[];
}

export interface HostApiEnv {
  appVersion: string;
  platform: 'win32' | 'darwin' | 'linux';
  locale: string;
  homeDir: string;
  userDataDir: string;
}

export interface PluginLogEntry {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** Messages between a view (SDK) and its backend, routed renderer ⇄ main ⇄ host. */
export type ViewEnvelope =
  | { kind: 'msg'; payload: unknown }
  | { kind: 'req'; id: number; method: string; payload: unknown }
  | { kind: 'res'; id: number; ok: true; result: unknown }
  | { kind: 'res'; id: number; ok: false; error: string }
  | { kind: 'evt'; name: string; payload: unknown };

export interface OpenViewRequest {
  /** Instance id of the view/panel. */
  viewId: string;
  pluginId: string;
  kind: 'view' | 'panel';
  /** `contributes.views[].id` or `contributes.panels[].type`. */
  providerId: string;
  projectId?: string;
  params?: unknown;
  visible: boolean;
}

export type PluginHostMethods = HostBaseMethods & {
  /** Sets the loaded plugins (removed ones are deactivated); settings snapshot for `oxy.settings`. */
  'plugins:load': (o: { plugins: HostPluginInfo[]; settings: Record<string, unknown>; env: HostApiEnv }) => void;
  /** Activates every loaded plugin listening to the event (`onStartup`, `onView:x`, …); returns their ids. */
  'plugins:activateByEvent': (o: { event: string }) => string[];
  'plugins:deactivate': (o: { id: string }) => void;
  /** Deactivates the plugin and activates it again with a fresh module (Plugins → Reload, dev auto-reload). */
  'plugins:reload': (o: { id: string }) => void;
  /** Runs a plugin command (activating `onCommand:<id>` first). */
  'commands:execute': (o: { id: string; args: unknown[] }) => unknown;
  /** Last 500 log entries of a plugin. */
  'plugins:logs': (o: { id: string }) => PluginLogEntry[];
  /** A view instance was mounted: resolves it with the plugin's provider. */
  'views:open': (o: OpenViewRequest) => void;
  'views:close': (o: { viewId: string }) => void;
  'views:visibility': (o: { viewId: string; visible: boolean }) => void;
  /** Message or request from a view to its backend. */
  'views:message': (o: { viewId: string; envelope: ViewEnvelope }) => void;
  /**
   * Runs a plugin's MCP tool: activates the plugin (`onMcpTool:<name>`) when needed, waits briefly for its handler and
   * enforces `timeoutMs`. A thrown error becomes a tool error.
   */
  'mcp:callTool': (o: {
    callId: string;
    pluginId: string;
    name: string;
    args: Record<string, unknown>;
    context: McpCallContext;
    timeoutMs: number;
  }) => McpToolResult;
};

/** Events the host sends to main. */
export type PluginHostEvents = HostBaseEvents & {
  'plugin:state': { id: string; state: 'active' | 'failed' | 'inactive'; error?: string };
  /** A call into plugin code started/finished (hang attribution). */
  'plugin:busy': { id: string | null };
  /** Backend → view (messages, responses, events). */
  'view:message': { viewId: string; envelope: ViewEnvelope };
  /** Title or badge set by the backend (`PluginView.title/badge`). */
  'view:meta': {
    viewId: string;
    title?: string;
    badge?: { text: string; tone?: 'neutral' | 'warning' | 'danger' } | null;
  };
};

/** Events main sends to the host (API events: projects, terminals, agents, git, settings). */
export type PluginHostInboundEvents = {
  'api:event': { name: string; payload: unknown };
  /** The agent cancelled an MCP tool call (or it timed out in main). */
  'mcp:cancel': { callId: string };
};

/** Host → main calls. */
export type PluginHostToMainMethods = {
  'api:call': (o: { pluginId: string; method: string; params: unknown }) => unknown;
};
