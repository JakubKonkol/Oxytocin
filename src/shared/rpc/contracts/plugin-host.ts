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

export type PluginHostMethods = HostBaseMethods & {
  /** Sets the loaded plugins (removed ones are deactivated); settings snapshot for `oxy.settings`. */
  'plugins:load': (o: { plugins: HostPluginInfo[]; settings: Record<string, unknown>; env: HostApiEnv }) => void;
  /** Activates every loaded plugin listening to the event (`onStartup`, `onView:x`, …); returns their ids. */
  'plugins:activateByEvent': (o: { event: string }) => string[];
  'plugins:deactivate': (o: { id: string }) => void;
  /** Runs a plugin command (activating `onCommand:<id>` first). */
  'commands:execute': (o: { id: string; args: unknown[] }) => unknown;
  /** Last 500 log entries of a plugin. */
  'plugins:logs': (o: { id: string }) => PluginLogEntry[];
};

/** Events the host sends to main. */
export type PluginHostEvents = HostBaseEvents & {
  'plugin:state': { id: string; state: 'active' | 'failed' | 'inactive'; error?: string };
  /** A call into plugin code started/finished (hang attribution). */
  'plugin:busy': { id: string | null };
};

/** Events main sends to the host (API events: projects, terminals, agents, git, settings). */
export type PluginHostInboundEvents = {
  'api:event': { name: string; payload: unknown };
};

/** Host → main calls. */
export type PluginHostToMainMethods = {
  'api:call': (o: { pluginId: string; method: string; params: unknown }) => unknown;
};
