/** Types shared by the Project Runner backend and its view (no Node.js or DOM APIs). */

export type RunnerKind =
  'node' | 'deno' | 'dotnet' | 'python' | 'go' | 'rust' | 'java' | 'php' | 'ruby' | 'docker' | 'make' | 'custom';

/** A run profile as the UI and the MCP tools see it: detected (possibly edited) or created by the user. */
export interface RunProfile {
  id: string;
  name: string;
  command: string;
  /** Relative to the project root, `/` separators, `''` = the root. */
  cwd: string;
  kind: RunnerKind;
  /** e.g. "Next.js", "ASP.NET Core", "Django". */
  framework?: string;
  /** Where the app is expected to answer; the runner reports the real address. */
  url?: string;
  env?: Record<string, string>;
  source: 'detected' | 'custom';
  /** A detected profile the user changed (its detected values are kept for "Reset"). */
  edited?: boolean;
}

export type RunStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type StartedBy = 'user' | 'agent';

/** A question the app asks in its terminal and waits on (e.g. whether to use another port). */
export interface RunPrompt {
  /** Changes with every new question. */
  id: number;
  text: string;
  /** Answered with yes or no. */
  yesNo: boolean;
}

/** What the UI and the MCP tools show about a profile's run. */
export interface RunSnapshot {
  profileId: string;
  /** The profile's name when it ran (for lists outside the view, e.g. the status bar). */
  name?: string;
  status: RunStatus;
  url?: string;
  ports: number[];
  startedAt?: number;
  startedBy?: StartedBy;
  exitCode?: number;
  terminalId?: string;
  /** The app waits for an answer in its terminal. */
  prompt?: RunPrompt;
}

/** A profile with its run, as sent to the views. */
export interface ProfileState extends RunProfile {
  run: RunSnapshot;
}

export interface McpState {
  enabled: boolean;
  port: number | null;
  error: string | null;
  /** Registered in Claude Code (null = unknown). */
  claude: boolean | null;
  calls: number;
}

/** Backend → view (`load` response and pushed updates). */
export interface RunnerState {
  type: 'state';
  project: { id: string; name: string; rootPath: string } | null;
  profiles: ProfileState[];
  scanning: boolean;
  mcp: McpState;
}
