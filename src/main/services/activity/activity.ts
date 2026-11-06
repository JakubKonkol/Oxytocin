import type { ProjectActivity, ProjectRuntimeStatus } from '@shared/domain/activity';
import type { TerminalInfo } from '@shared/domain/terminal';

const isError = (t: TerminalInfo) => t.state === 'failed' || (t.state === 'exited' && (t.exitCode ?? 0) !== 0);

/** Something runs in the terminal: a process or an agent that is not idle. */
const isBusy = (t: TerminalInfo) =>
  t.state === 'running' && (t.kind === 'process' || (t.kind === 'agent' && t.agent?.state !== 'idle'));

/**
 * Terminals that mark the project. A background terminal (a Project Runner script, an Ensemble session) has no
 * panel, so it counts only while something runs in it: its idle shell after a finished script, or its exit, would
 * otherwise keep the project's dot on with nothing to look at.
 */
export function visibleActivityTerminals(ts: readonly TerminalInfo[]): TerminalInfo[] {
  return ts.filter((t) => !t.background || isBusy(t));
}

/** Project activity, highest priority first. */
export function deriveActivity(all: readonly TerminalInfo[], seen: ReadonlySet<string>): ProjectActivity {
  const ts = visibleActivityTerminals(all);
  if (ts.length === 0) return 'none';
  if (ts.some((t) => t.state === 'running' && t.agent?.state === 'waiting')) return 'attention';
  if (ts.some((t) => isError(t) && !seen.has(t.id))) return 'error';
  if (ts.some((t) => t.state === 'running' && t.agent?.state === 'working')) return 'agent-working';
  if (ts.some((t) => isBusy(t))) return 'running';
  return 'idle';
}

export function runtimeStatus(
  projectId: string,
  all: readonly TerminalInfo[],
  seen: ReadonlySet<string>,
  exitedAt: ReadonlyMap<string, number>,
): ProjectRuntimeStatus {
  const ts = visibleActivityTerminals(all);
  const running = ts.filter((t) => t.state === 'running');
  const agentsIn = (state: string) => running.filter((t) => t.kind === 'agent' && t.agent?.state === state).length;
  const unseen = ts.find((t) => isError(t) && !seen.has(t.id));
  return {
    projectId,
    activity: deriveActivity(ts, seen),
    terminals: ts.length,
    runningProcesses: running.filter((t) => t.kind === 'process').length,
    agents: { working: agentsIn('working'), waiting: agentsIn('waiting'), idle: agentsIn('idle') },
    ...(unseen
      ? { unseenError: { terminalId: unseen.id, exitCode: unseen.exitCode ?? -1, at: exitedAt.get(unseen.id) ?? 0 } }
      : {}),
  };
}
