import type { TerminalInfo } from '@shared/domain/terminal';
import { displayCommandLine } from '@shared/utils/command-line';

export interface QuitPrompt {
  message: string;
  detail: string;
}

const MAX_LISTED = 8;

function shorten(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What runs in a terminal: the agent, else the foreground command line. */
export function runningLabel(t: TerminalInfo): string {
  if (t.agent) return t.agent.displayName;
  if (t.kind === 'agent') return t.profileName;
  return shorten(displayCommandLine(t.foreground?.commandLine || t.foreground?.name || t.title));
}

/** Terminals whose process would be killed by quitting (a child process or an agent is running). */
export function busyTerminals(terminals: readonly TerminalInfo[]): TerminalInfo[] {
  return terminals.filter((t) => t.state === 'running' && t.kind !== 'shell');
}

/**
 * "2 terminals have running processes (Claude Code in ‘api’, npm run dev in ‘web’). Quit anyway?"
 * plus one line per terminal.
 */
export function describeQuit(
  busy: readonly TerminalInfo[],
  projectName: (id: string) => string | undefined,
): QuitPrompt {
  const where = (t: TerminalInfo) => {
    const name = projectName(t.projectId);
    return name ? `${runningLabel(t)} in ‘${name}’` : runningLabel(t);
  };
  const summary = busy.slice(0, 2).map(where).join(', ') + (busy.length > 2 ? '…' : '');
  const message = `${busy.length} ${busy.length === 1 ? 'terminal has a running process' : 'terminals have running processes'} (${summary}). Quit anyway?`;
  const lines = busy.slice(0, MAX_LISTED).map((t) => `• ${where(t)} — ${t.title}`);
  if (busy.length > MAX_LISTED) lines.push(`• …and ${busy.length - MAX_LISTED} more`);
  return { message, detail: `${lines.join('\n')}\n\nThese processes will be stopped.` };
}
