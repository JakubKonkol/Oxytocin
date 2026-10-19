import type { AgentInfoWithTerminal } from '@shared/domain/agent';
import type { AgentLaunchRequest, AgentLaunchResult } from '@shared/domain/agent-launch';
import type { TerminalInfo } from '@shared/domain/terminal';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { OxyError } from '@shared/errors';

export interface AgentLauncherDeps {
  profile(id: string): Promise<TerminalProfile | undefined>;
  agents(): AgentInfoWithTerminal[];
  terminals(projectId: string): TerminalInfo[];
  /** `launch`: the command typed into the new terminal (its arguments quoted for the shell) and extra variables. */
  create(projectId: string, profileId: string, launch?: NewSessionLaunch): Promise<TerminalInfo>;
  show(terminalId: string, projectId: string): void;
  send(terminalId: string, prompt: string): Promise<{ ok: true } | { ok: false; error: string }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface NewSessionLaunch {
  command?: { head: string; args: string[] };
  env?: Record<string, string>;
}

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
    if (!terminal) {
      const claude = profile.icon === 'agent-claude';
      const args = claude ? [...(o.planMode ? ['--permission-mode', 'plan'] : []), ...(o.claudeArgs ?? [])] : [];
      terminal = await this.deps.create(o.projectId, o.launchId, {
        ...(args.length > 0 ? { command: { head: profile.command ?? 'claude', args } } : {}),
        ...(o.env && Object.keys(o.env).length > 0 ? { env: o.env } : {}),
      });
    }
    this.deps.show(terminal.id, o.projectId);
    if (!o.prompt) return { terminalId: terminal.id, reused, sent: false };
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
