import { isAbsolute, join, relative, resolve } from 'node:path';
import type { McpPolicy, McpToolDefinition, McpToolInfo, McpToolResult } from '@shared/domain/mcp';
import type { TerminalInfo } from '@shared/domain/terminal';
import { fromShellPath } from '@shared/utils/shell-path';
import { NO_PROJECT_MESSAGE, type ResolvedCaller } from './caller-context';

export interface CoreProject {
  id: string;
  name: string;
  rootPath: string;
}

/** What the core tools need from Oxytocin (kept narrow for tests). */
export interface CoreToolsDeps {
  /** Every tool with its state (for `oxy_capabilities`). */
  tools(): McpToolInfo[];
  projects(): CoreProject[];
  activeProjectId(): string | null;
  branch(projectId: string): string | undefined;
  terminals(projectId?: string): TerminalInfo[];
  /** Plain text of a terminal's buffer (VT sequences already interpreted). */
  terminalText(id: string): Promise<string>;
  /** A toast in the window, plus an OS notification when the window is not focused. */
  notify(o: { title: string; message: string; level: 'info' | 'warning' | 'error' }): void;
  /** Asks the user in a dialog; null when nobody answered in time or the dialog was dismissed. */
  ask(o: {
    title: string;
    question: string;
    options?: string[];
    placeholder?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<string | null>;
  /** Opens a file of a project in the preview (or the editor), at a line. */
  openFile(o: { projectId: string; path: string; line?: number }): Promise<void>;
  isFile(path: string): Promise<boolean>;
  platform: string;
  now?: () => number;
}

export interface CoreToolCall {
  args: Record<string, unknown>;
  caller: ResolvedCaller;
  sessionId: string;
  signal: AbortSignal;
}

export interface CoreTool {
  definition: McpToolDefinition;
  /** Overrides the policy derived from the annotations. */
  defaultPolicy?: McpPolicy;
  run(call: CoreToolCall): Promise<McpToolResult | string> | McpToolResult | string;
}

const PROJECT_ARGS = {
  cwd: {
    type: 'string',
    description: 'Your current working directory; selects the Oxytocin project that contains it.',
  },
  project: { type: 'string', description: 'Project name, id or root folder (instead of cwd).' },
};

const MAX_OUTPUT_LINES = 1000;
const NOTIFY_LIMIT = { count: 5, windowMs: 60_000 };
const ASK_DEFAULT_S = 300;
const ASK_MAX_S = 590;

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

function projectOf(deps: CoreToolsDeps, caller: ResolvedCaller): CoreProject {
  const id = caller.context.projectId;
  const project = id ? deps.projects().find((p) => p.id === id) : undefined;
  if (!project) throw new Error(caller.projectError ?? NO_PROJECT_MESSAGE);
  return project;
}

function describeTerminal(t: TerminalInfo) {
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    ...(t.agent ? { agent: t.agent.displayName, agentState: t.agent.state } : {}),
    cwd: t.cwd,
    status: t.state,
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    ...(t.command ? { runningCommand: t.command.commandLine ?? '(unknown)' } : {}),
    ...(!t.command && t.foreground ? { runningProcess: t.foreground.commandLine || t.foreground.name } : {}),
    ...(t.lastCommand
      ? {
          lastCommand: {
            commandLine: t.lastCommand.commandLine,
            ...(t.lastCommand.exitCode !== undefined ? { exitCode: t.lastCommand.exitCode } : {}),
            ...(t.lastCommand.interrupted ? { interrupted: true } : {}),
          },
        }
      : {}),
  };
}

/** Oxytocin's own tools (`oxy_*`): useful to any agent and safe by default. They never write files or run commands. */
export function buildCoreTools(deps: CoreToolsDeps): CoreTool[] {
  const now = deps.now ?? Date.now;
  const notifications = new Map<string, number[]>();

  const findTerminal = (args: Record<string, unknown>, caller: ResolvedCaller): TerminalInfo => {
    const wanted = args['terminal'];
    if (typeof wanted !== 'string' || !wanted.trim())
      throw new Error('Pass `terminal` (a terminal id or title from oxy_list_terminals).');
    const all = deps.terminals();
    const byId = all.find((t) => t.id === wanted.trim());
    if (byId) return byId;
    const projectId = caller.context.projectId;
    const matches = all.filter(
      (t) => t.title.toLowerCase() === wanted.trim().toLowerCase() && (!projectId || t.projectId === projectId),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new Error(`Several terminals are titled "${wanted}"; pass the id (see oxy_list_terminals).`);
    throw new Error(`No terminal "${wanted}". Call oxy_list_terminals to see the terminals.`);
  };

  return [
    {
      definition: {
        name: 'oxy_capabilities',
        title: 'List Oxytocin tools',
        description:
          'Lists every tool Oxytocin currently offers, grouped by the plugin that provides it, with one line each. Call it when you are unsure which Oxytocin tools exist (plugins can add tools while you work).',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run: () => {
        const groups = new Map<string, string[]>();
        for (const t of deps.tools().filter((x) => x.listed)) {
          const group = t.source.kind === 'core' ? 'Oxytocin' : t.source.pluginName;
          const line = `- ${t.name}: ${t.description.split(/(?<=\.)\s/)[0]}${t.policy === 'ask' ? ' (asks the user first)' : ''}`;
          groups.set(group, [...(groups.get(group) ?? []), line]);
        }
        return [...groups].map(([group, lines]) => `${group}\n${lines.join('\n')}`).join('\n\n');
      },
    },
    {
      definition: {
        name: 'oxy_list_projects',
        title: 'List projects',
        description:
          'Lists the projects open in Oxytocin with their root folder and git branch, and which one the user is looking at.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run: () => {
        const active = deps.activeProjectId();
        return json(
          deps.projects().map((p) => {
            const branch = deps.branch(p.id);
            return {
              id: p.id,
              name: p.name,
              root: p.rootPath,
              ...(branch ? { branch } : {}),
              ...(p.id === active ? { active: true } : {}),
            };
          }),
        );
      },
    },
    {
      definition: {
        name: 'oxy_list_terminals',
        title: 'List terminals',
        description:
          'Lists the terminals of a project open in Oxytocin (shells, dev servers, other agents): title, id, folder, the command running now and the last command with its exit code. Use it to find a terminal for oxy_read_terminal_output.',
        inputSchema: {
          type: 'object',
          properties: {
            ...PROJECT_ARGS,
            all_projects: { type: 'boolean', description: 'List the terminals of every project.' },
          },
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run: ({ args, caller }) => {
        if (args['all_projects'] === true) {
          const projects = new Map(deps.projects().map((p) => [p.id, p.name]));
          return json(
            deps
              .terminals()
              .map((t) => ({ project: projects.get(t.projectId) ?? t.projectId, ...describeTerminal(t) })),
          );
        }
        const project = projectOf(deps, caller);
        const terminals = deps.terminals(project.id);
        return json({
          project: { name: project.name, root: project.rootPath },
          terminals: terminals.map(describeTerminal),
          ...(caller.context.terminalId ? { yourTerminal: caller.context.terminalId } : {}),
        });
      },
    },
    {
      definition: {
        name: 'oxy_read_terminal_output',
        title: 'Read terminal output',
        description:
          "Returns the last lines (plain text) of another Oxytocin terminal, e.g. a dev server's errors or a test run the user started. Find terminals with oxy_list_terminals.",
        inputSchema: {
          type: 'object',
          properties: {
            terminal: { type: 'string', description: 'Terminal id or title (see oxy_list_terminals).' },
            lines: {
              type: 'number',
              description: `Number of lines from the end (default 100, max ${MAX_OUTPUT_LINES}).`,
            },
            ...PROJECT_ARGS,
          },
          required: ['terminal'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      defaultPolicy: 'ask',
      run: async ({ args, caller }) => {
        const terminal = findTerminal(args, caller);
        const count = clamp(args['lines'], 1, MAX_OUTPUT_LINES, 100);
        const text = await deps.terminalText(terminal.id);
        const lines = text.replace(/\s+$/, '').split('\n');
        const tail = lines.slice(-count);
        const header = `${terminal.title} (${terminal.state}${terminal.command?.commandLine ? `, running ${terminal.command.commandLine}` : ''}) — last ${tail.length} of ${lines.length} lines:`;
        return `${header}\n${tail.join('\n')}`;
      },
    },
    {
      definition: {
        name: 'oxy_notify_user',
        title: 'Notify the user',
        description:
          'Shows the user a short notification in Oxytocin (and a system notification when Oxytocin is in the background), e.g. when a long task is done or needs attention. Do not use it for every step.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'What to tell the user (one or two sentences).' },
            level: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Default: info.' },
          },
          required: ['message'],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      run: ({ args, caller, sessionId }) => {
        const message = args['message'];
        if (typeof message !== 'string' || !message.trim()) throw new Error('Pass `message`.');
        const at = now();
        const recent = (notifications.get(sessionId) ?? []).filter((t) => at - t < NOTIFY_LIMIT.windowMs);
        if (recent.length >= NOTIFY_LIMIT.count)
          throw new Error('Too many notifications: at most 5 per minute. Tell the user in your reply instead.');
        notifications.set(sessionId, [...recent, at]);
        const level = args['level'] === 'warning' || args['level'] === 'error' ? args['level'] : 'info';
        deps.notify({
          title: caller.label ? `Agent · ${caller.label}` : 'Agent',
          message: message.slice(0, 500),
          level,
        });
        return 'The user was notified.';
      },
    },
    {
      definition: {
        name: 'oxy_ask_user',
        title: 'Ask the user',
        description:
          'Asks the user a question in an Oxytocin dialog and waits for the answer: pick one of `options`, or type a free answer when there are none. Returns the answer, or that nobody answered in time. Use it when you need a decision and the user may not be watching your terminal.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Answers to choose from (2–10). Without them the user types an answer.',
            },
            placeholder: { type: 'string', description: 'Hint shown in the empty answer field.' },
            timeout_seconds: {
              type: 'number',
              description: `How long to wait for an answer (default ${ASK_DEFAULT_S}, max ${ASK_MAX_S}).`,
            },
          },
          required: ['question'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        timeoutMs: 600_000,
      },
      run: async ({ args, caller, signal }) => {
        const question = args['question'];
        if (typeof question !== 'string' || !question.trim()) throw new Error('Pass `question`.');
        const raw = args['options'];
        const options = Array.isArray(raw)
          ? raw.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.slice(0, 200))
          : [];
        if (options.length === 1 || options.length > 10) throw new Error('Pass 2–10 `options`, or none.');
        const seconds = clamp(args['timeout_seconds'], 5, ASK_MAX_S, ASK_DEFAULT_S);
        const answer = await deps.ask({
          title: caller.label ? `An agent asks · ${caller.label}` : 'An agent asks',
          question: question.slice(0, 2000),
          ...(options.length ? { options } : {}),
          ...(typeof args['placeholder'] === 'string' ? { placeholder: args['placeholder'].slice(0, 200) } : {}),
          timeoutMs: seconds * 1000,
          signal,
        });
        if (answer === null) return `The user did not answer within ${seconds} s (or closed the dialog).`;
        return `The user answered: ${answer}`;
      },
    },
    {
      definition: {
        name: 'oxy_open_file',
        title: 'Open a file for the user',
        description:
          'Opens a file of the project in Oxytocin for the user to look at (a preview tab, or the editor), scrolled to a line. Use it to point the user at something you changed or found.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, absolute or relative to the project root.' },
            line: { type: 'number', description: 'Line to show (1-based).' },
            ...PROJECT_ARGS,
          },
          required: ['path'],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run: async ({ args, caller }) => {
        const project = projectOf(deps, caller);
        const raw = args['path'];
        if (typeof raw !== 'string' || !raw.trim()) throw new Error('Pass `path`.');
        const converted = fromShellPath(raw.trim(), deps.platform);
        const path = isAbsolute(converted) ? resolve(converted) : join(project.rootPath, converted);
        const rel = relative(project.rootPath, path);
        if (rel.startsWith('..') || isAbsolute(rel))
          throw new Error(`${raw} is outside the project ${project.name} (${project.rootPath}).`);
        if (!(await deps.isFile(path))) throw new Error(`${raw} is not a file.`);
        const line = typeof args['line'] === 'number' && args['line'] >= 1 ? Math.floor(args['line']) : undefined;
        await deps.openFile({ projectId: project.id, path, ...(line ? { line } : {}) });
        return `Opened ${rel || path}${line ? ` at line ${line}` : ''} for the user.`;
      },
    },
  ];
}
