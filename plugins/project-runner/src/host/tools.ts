import type { McpCallContext, ProjectInfo } from '@oxytocin/plugin-api';
import type { McpTool } from './mcp';
import type { ProfileInput, RunProfile } from './profiles';
import type { RunSnapshot } from './runner';

/** What the MCP tools need from the plugin (kept narrow for tests). */
export interface RunnerTools {
  /** The project of a call: its `project`/`cwd` argument, else the caller's project (Oxytocin's MCP server). */
  resolveProject(
    args: { project?: unknown; cwd?: unknown },
    context?: Pick<McpCallContext, 'projectId'>,
  ): Promise<ProjectInfo>;
  profiles(project: ProjectInfo): Promise<RunProfile[]>;
  profile(project: ProjectInfo, idOrName: string): Promise<RunProfile>;
  snapshot(project: ProjectInfo, profileId: string): RunSnapshot;
  start(project: ProjectInfo, profile: RunProfile): Promise<RunSnapshot>;
  restart(project: ProjectInfo, profile: RunProfile): Promise<RunSnapshot>;
  stop(project: ProjectInfo, profileId: string): Promise<RunSnapshot>;
  waitFor(
    project: ProjectInfo,
    profileId: string,
    done: (s: RunSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<RunSnapshot>;
  logs(project: ProjectInfo, profileId: string, lines: number): string[];
  answer(project: ProjectInfo, profileId: string, text: string): Promise<RunSnapshot>;
  addProfile(project: ProjectInfo, input: ProfileInput): Promise<RunProfile>;
}

const PROJECT_ARGS = {
  cwd: {
    type: 'string',
    description: 'Your current working directory; selects the Oxytocin project that contains it.',
  },
  project: { type: 'string', description: 'Project name, id or root folder (instead of cwd).' },
};
/** Tool names in Oxytocin's MCP server (prefix `run`). */
export const TOOL_NAMES = {
  list: 'run_list_profiles',
  start: 'run_start_profile',
  restart: 'run_restart_profile',
  stop: 'run_stop_profile',
  logs: 'run_get_logs',
  answer: 'run_answer_prompt',
  add: 'run_add_profile',
} as const;

/** Names on the plugin's own server `oxytocin-runner` (Oxytocin ≤ 0.6.0; kept for one release). */
export const LEGACY_TOOL_NAMES: Record<keyof typeof TOOL_NAMES, string> = {
  list: 'list_run_profiles',
  start: 'start_run_profile',
  restart: 'restart_run_profile',
  stop: 'stop_run_profile',
  logs: 'get_run_logs',
  answer: 'answer_run_prompt',
  add: 'add_run_profile',
};

export type ToolNames = Record<keyof typeof TOOL_NAMES, string>;

const profileArg = (args: Record<string, unknown>) => {
  const value = args['profile'];
  if (typeof value !== 'string' || !value.trim()) throw new Error('Pass `profile` (a run profile id or name).');
  return value;
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

function describeRun(profile: RunProfile, run: RunSnapshot): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.framework ? { framework: profile.framework } : {}),
    command: profile.command,
    folder: profile.cwd || '.',
    status: run.status,
    ...(run.url ? { url: run.url } : profile.url ? { expectedUrl: profile.url } : {}),
    ...(run.ports.length ? { ports: run.ports } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.startedBy ? { startedBy: run.startedBy } : {}),
    ...(profile.script?.file ? { script: profile.script.file } : {}),
    ...(run.prompt ? { waitingForInput: run.prompt.text } : {}),
  };
}

/** Ready, ended or asking something (a question never resolves by waiting). */
const isSettled = (s: RunSnapshot) => s.status !== 'starting' || !!s.prompt;

/** Status line plus the recent output an agent needs to judge a start or a crash. */
function report(names: ToolNames, profile: RunProfile, run: RunSnapshot, logs: string[]): string {
  const lines = [JSON.stringify(describeRun(profile, run), null, 2)];
  if (run.prompt)
    lines.push(
      run.prompt.key
        ? `The app waits for a key in its terminal: "${run.prompt.text}". Continue with ${names.answer} and an empty answer (Enter).`
        : `The app is waiting for an answer in its terminal: "${run.prompt.text}". Ask the user (it is also shown in Oxytocin) or answer with ${names.answer}.`,
    );
  else if (run.status === 'starting')
    lines.push(`Still starting — call ${names.logs} or ${names.list} later to check it.`);
  if (logs.length) lines.push('', `Last ${logs.length} lines of output:`, ...logs);
  return lines.join('\n');
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const ACTS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** The tools, named for Oxytocin's MCP server (default) or the legacy `oxytocin-runner` server. */
export function buildTools(r: RunnerTools, names: ToolNames = TOOL_NAMES): McpTool[] {
  const PROFILE_ARG = { type: 'string', description: `Run profile id or name (see ${names.list}).` };
  return [
    {
      name: names.list,
      title: 'List run profiles',
      annotations: READ_ONLY,
      description:
        'Lists the run profiles (apps that can be started: dev servers, APIs, workers) of a project open in Oxytocin with their status (idle, starting, running, stopping, stopped, failed) and URL.',
      inputSchema: { type: 'object', properties: { ...PROJECT_ARGS } },
      handler: async (args, context) => {
        const project = await r.resolveProject(args, context);
        const profiles = await r.profiles(project);
        return JSON.stringify(
          {
            project: { name: project.name, root: project.rootPath },
            profiles: profiles.map((p) => describeRun(p, r.snapshot(project, p.id))),
          },
          null,
          2,
        );
      },
    },
    {
      name: names.start,
      title: 'Start a run profile',
      annotations: ACTS,
      description:
        'Starts a run profile in an Oxytocin terminal (the user sees it in the Run panel) and waits until the app serves a URL/port, exits or `wait_seconds` pass. Returns the status, the URL and the recent output. Does nothing when it already runs.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: PROFILE_ARG,
          ...PROJECT_ARGS,
          wait_seconds: {
            type: 'number',
            description: 'How long to wait for the app to be ready (default 30, max 120).',
          },
        },
        required: ['profile'],
      },
      handler: async (args, context) => {
        const project = await r.resolveProject(args, context);
        const profile = await r.profile(project, profileArg(args));
        await r.start(project, profile);
        const run = await r.waitFor(project, profile.id, isSettled, clamp(args['wait_seconds'], 0, 120, 30) * 1000);
        return report(names, profile, run, r.logs(project, profile.id, run.status === 'running' ? 15 : 40));
      },
    },
    {
      name: names.restart,
      title: 'Restart a run profile',
      annotations: ACTS,
      description: `Stops a run profile (if it runs) and starts it again, then waits like ${names.start}.`,
      inputSchema: {
        type: 'object',
        properties: { profile: PROFILE_ARG, ...PROJECT_ARGS, wait_seconds: { type: 'number' } },
        required: ['profile'],
      },
      handler: async (args, context) => {
        const project = await r.resolveProject(args, context);
        const profile = await r.profile(project, profileArg(args));
        await r.restart(project, profile);
        const run = await r.waitFor(project, profile.id, isSettled, clamp(args['wait_seconds'], 0, 120, 30) * 1000);
        return report(names, profile, run, r.logs(project, profile.id, run.status === 'running' ? 15 : 40));
      },
    },
    {
      name: names.stop,
      title: 'Stop a run profile',
      annotations: ACTS,
      description: 'Stops a running profile (Ctrl+C, then a forced kill after a few seconds) and waits for it to end.',
      inputSchema: { type: 'object', properties: { profile: PROFILE_ARG, ...PROJECT_ARGS }, required: ['profile'] },
      handler: async (args, context) => {
        const project = await r.resolveProject(args, context);
        const profile = await r.profile(project, profileArg(args));
        await r.stop(project, profile.id);
        const run = await r.waitFor(project, profile.id, (s) => s.status !== 'stopping', 15_000);
        return JSON.stringify(describeRun(profile, run), null, 2);
      },
    },
    {
      name: names.logs,
      title: 'Get run output',
      annotations: READ_ONLY,
      description:
        'Returns the recent output (plain text) of a run profile — the dev server log with errors and stack traces.',
      inputSchema: {
        type: 'object',
        properties: {
          profile: PROFILE_ARG,
          ...PROJECT_ARGS,
          lines: { type: 'number', description: 'Number of lines from the end (default 100, max 500).' },
        },
        required: ['profile'],
      },
      handler: async (args, context) => {
        const project = await r.resolveProject(args, context);
        const profile = await r.profile(project, profileArg(args));
        const logs = r.logs(project, profile.id, clamp(args['lines'], 1, 500, 100));
        const run = r.snapshot(project, profile.id);
        return `${profile.name}: ${run.status}${run.url ? ` (${run.url})` : ''}\n${logs.length ? logs.join('\n') : '(no output yet)'}`;
      },
    },
    {
      name: names.answer,
      title: 'Answer a run profile question',
      annotations: ACTS,
      description: `Types an answer (followed by Enter) into the terminal of a run profile that waits for input, e.g. "y" when the dev server asks whether to use another port (see \`waitingForInput\` in the status). Then waits like ${names.start}.`,
      inputSchema: {
        type: 'object',
        properties: {
          profile: PROFILE_ARG,
          answer: { type: 'string', description: 'The text to type, e.g. "y" or "n" ("" only presses Enter).' },
          ...PROJECT_ARGS,
          wait_seconds: { type: 'number' },
        },
        required: ['profile', 'answer'],
      },
      handler: async (args, context) => {
        const answer = args['answer'];
        if (typeof answer !== 'string' || answer.length > 200) throw new Error('Pass `answer` (the text to type).');
        const project = await r.resolveProject(args, context);
        const profile = await r.profile(project, profileArg(args));
        const before = r.snapshot(project, profile.id);
        if (!before.prompt) throw new Error(`${profile.name} is not waiting for input (status: ${before.status}).`);
        await r.answer(project, profile.id, answer);
        const run = await r.waitFor(project, profile.id, isSettled, clamp(args['wait_seconds'], 0, 120, 30) * 1000);
        return report(names, profile, run, r.logs(project, profile.id, run.status === 'running' ? 15 : 40));
      },
    },
    {
      name: names.add,
      title: 'Add a run profile',
      annotations: ACTS,
      description:
        'Adds a run profile to a project (e.g. a command the auto-detection missed). It is saved for the user and shown in the Run panel.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name, e.g. "api".' },
          command: { type: 'string', description: 'Command typed into the terminal, e.g. "npm run dev".' },
          folder: { type: 'string', description: 'Folder relative to the project root (default: the root).' },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables.' },
          ...PROJECT_ARGS,
        },
        required: ['name', 'command'],
      },
      handler: async (args, context) => {
        const project = await r.resolveProject(args, context);
        const profile = await r.addProfile(project, {
          name: args['name'],
          command: args['command'],
          cwd: args['folder'],
          env: args['env'],
        });
        return `Added run profile ${profile.name} (id ${profile.id}) to ${project.name}.`;
      },
    },
  ];
}
