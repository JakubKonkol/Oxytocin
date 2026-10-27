import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { AgentLaunchRequest, AgentLaunchResult } from '@shared/domain/agent-launch';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { OxyError } from '@shared/errors';
import type { ShellKind } from '@shared/utils/shell-command';

export interface AgentLauncherDeps {
  profile(id: string): Promise<TerminalProfile | undefined>;
  agents(): AgentInfoWithTerminal[];
  terminals(projectId: string): TerminalInfo[];
  /**
   * `launch`: the command typed into the new terminal (its arguments are quoted for the terminal's shell, which
   * `command` receives) and extra variables.
   */
  create(projectId: string, profileId: string, launch?: NewSessionLaunch): Promise<TerminalInfo>;
  show(terminalId: string, projectId: string): void;
  send(terminalId: string, prompt: string): Promise<{ ok: true } | { ok: false; error: string }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface NewSessionLaunch {
  command?: (shell: ShellKind) => { head: string; args: string[] };
  env?: Record<string, string>;
}

/** CLIs that take their first prompt on the command line and open an interactive session with it. */
const STARTUP_PROMPT: Record<string, (prompt: string) => string[]> = {
  claude: (prompt) => [prompt],
  codex: (prompt) => [prompt],
  gemini: (prompt) => ['--prompt-interactive', prompt],
  qwen: (prompt) => ['--prompt-interactive', prompt],
};
/**
 * Directories a new session may use besides the project (Codex reads anywhere; its flag adds a writable root).
 * Claude Code's `--add-dir` keeps a prompt given on the same command line from being submitted (the session opens
 * with an empty turn, anthropics/claude-code#92930), so a Claude session with extra directories gets its prompt typed
 * once it is ready instead.
 */
const ADD_DIR: Record<string, string> = {
  claude: '--add-dir',
  codex: '--add-dir',
  gemini: '--include-directories',
  qwen: '--include-directories',
};
export const MAX_STARTUP_PROMPT = 2000;

/**
 * The prompt as arguments of a new session's command line, when the CLI takes one and the prompt survives the shell
 * as typed: one line, no control characters, and nothing cmd.exe expands inside quotes (`%`, `!`). The agent then
 * starts with the prompt: no waiting for it to be ready and nothing typed into its input box.
 */
export function startupPromptArgs(cli: string, prompt: string, shell: ShellKind): string[] | undefined {
  const args = STARTUP_PROMPT[cli];
  // eslint-disable-next-line no-control-regex
  if (!args || prompt.length > MAX_STARTUP_PROMPT || /[\u0000-\u001f\u007f]/.test(prompt)) return undefined;
  if (shell === 'cmd' && /[%!]/.test(prompt)) return undefined;
  return args(prompt);
}

/** The CLI a profile starts (`claude`, `codex`…), from its icon (`agent-<id>`). */
const cliOf = (profile: TerminalProfile) => (profile.icon?.startsWith('agent-') ? profile.icon.slice(6) : '');

/** Launches ordinary workspace terminals. Serializes requests so two clicks cannot spawn duplicates. */
export class AgentLauncherService {
  private queue = Promise.resolve();
  constructor(private readonly deps: AgentLauncherDeps) {}

  launch(request: AgentLaunchRequest): Promise<AgentLaunchResult> {
    const result = this.queue.then(() => this.run(request));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async run(o: AgentLaunchRequest): Promise<AgentLaunchResult> {
    const profile = await this.deps.profile(o.launchId);
    if (!profile) throw new OxyError('NOT_FOUND', 'This AI agent or profile is no longer available.');
    const all = this.deps.terminals(o.projectId).filter((t) => t.state === 'running');
    const agentIn = (id: string) => this.deps.agents().find((a) => a.terminalId === id);
    const matching = (o.reuse === false ? [] : all).filter((t) => t.profileId === o.launchId);
    let terminal = o.terminalId
      ? all.find((t) => t.id === o.terminalId)
      : matching.find((t) => agentIn(t.id)?.state === 'idle');
    if (o.terminalId && (!terminal || !agentIn(terminal.id)))
      throw new OxyError('NOT_FOUND', 'The selected agent session is no longer running in this project.');
    if (o.terminalId && terminal?.profileId !== o.launchId)
      throw new OxyError('INVALID', 'The selected session belongs to another agent profile.');
    // A matching busy or starting session is shown instead of spawning a duplicate.
    terminal ??= matching[0];
    const reused = !!terminal;
    let passed = false;
    if (!terminal) {
      const cli = cliOf(profile);
      const args = [
        ...(cli === 'claude' ? [...(o.planMode ? ['--permission-mode', 'plan'] : []), ...(o.claudeArgs ?? [])] : []),
        ...(ADD_DIR[cli] ? (o.addDirs ?? []).flatMap((dir) => [ADD_DIR[cli]!, dir]) : []),
      ];
      const prompt = cli === 'claude' && (o.addDirs ?? []).length > 0 ? undefined : o.prompt;
      const head = profile.command ?? cli;
      terminal = await this.deps.create(o.projectId, o.launchId, {
        ...(args.length > 0 || (prompt && STARTUP_PROMPT[cli])
          ? {
              command: (shell: ShellKind) => {
                const promptArgs = prompt ? startupPromptArgs(cli, prompt, shell) : undefined;
                passed = !!promptArgs;
                // The prompt comes first: an option that takes several values (Claude Code's `--add-dir`, Gemini's
                // `--include-directories`) would read a prompt after it as one more value.
                return { head, args: [...(promptArgs ?? []), ...args] };
              },
            }
          : {}),
        ...(o.env && Object.keys(o.env).length > 0 ? { env: o.env } : {}),
      });
    }
    this.deps.show(terminal.id, o.projectId);
    if (!o.prompt) return { terminalId: terminal.id, reused, sent: false };
    // The new session received the prompt as an argument of its command line.
    if (passed) return { terminalId: terminal.id, reused, sent: true };
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = now() + 15_000;
    let agent = agentIn(terminal.id);
    while ((!agent || agent.state === 'starting' || agent.state === 'unknown') && now() < deadline) {
      await sleep(200);
      agent = agentIn(terminal.id);
    }
    if (agent?.state !== 'idle')
      return {
        terminalId: terminal.id,
        reused,
        sent: false,
        error: 'The agent is not ready. Finish its current turn or answer the question in its terminal, then retry.',
      };
    const result = await this.deps.send(terminal.id, o.prompt);
    return { terminalId: terminal.id, reused, sent: result.ok, ...(!result.ok ? { error: result.error } : {}) };
  }
}
