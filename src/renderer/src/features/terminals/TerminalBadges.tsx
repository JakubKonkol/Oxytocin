import { Bell } from 'lucide-react';
import type { TerminalInfo } from '@shared/domain/terminal';
import { Badge } from '../../ui/Badge';

/** Kind badge: AI AGENT / PROCESS / SHELL, or EXITED (code) for a non-zero exit. */
export function TerminalKindBadge({ info }: { info: TerminalInfo }) {
  if (info.state === 'exited' && (info.exitCode ?? 0) !== 0) {
    return <Badge variant="danger" testId="terminal-kind-badge">{`EXITED (${info.exitCode})`}</Badge>;
  }
  if (info.state === 'failed')
    return (
      <Badge variant="danger" testId="terminal-kind-badge">
        DISCONNECTED
      </Badge>
    );
  if (info.kind === 'agent') {
    const state = info.agent?.state;
    if (state === 'waiting') {
      return (
        <Badge variant="warning" testId="terminal-kind-badge" dataState={state}>
          WAITING
        </Badge>
      );
    }
    return (
      <Badge variant="agent" testId="terminal-kind-badge" dataState={state ?? 'starting'}>
        {state === 'working' && (
          <span
            aria-hidden
            className="mr-1 size-1.5 animate-[oxy-breathe_1.6s_ease-in-out_infinite] rounded-full bg-agent"
          />
        )}
        AI AGENT
      </Badge>
    );
  }
  if (info.kind === 'process')
    return (
      <Badge variant="process" testId="terminal-kind-badge" title={info.foreground?.commandLine}>
        PROCESS
      </Badge>
    );
  return (
    <Badge variant="shell" testId="terminal-kind-badge">
      SHELL
    </Badge>
  );
}

export function BellIndicator({ info }: { info: TerminalInfo }) {
  if (!info.bell) return null;
  return <Bell data-testid="terminal-bell" aria-label="Bell" size={12} className="flex-none text-warning" />;
}

/** Thin OSC 9;4 progress line (normal, error, indeterminate, paused/warning). */
export function TerminalProgress({ info }: { info: TerminalInfo }) {
  const p = info.progress;
  if (!p || p.state === 0) return null;
  const color = p.state === 2 ? 'bg-danger' : p.state === 4 ? 'bg-warning' : 'bg-accent';
  return (
    <div
      data-testid="terminal-progress"
      data-state={p.state}
      className="relative h-0.5 w-full overflow-hidden bg-transparent"
    >
      {p.state === 3 ? (
        <div className={`absolute inset-y-0 w-1/3 animate-[oxy-indeterminate_1.2s_ease-in-out_infinite] ${color}`} />
      ) : (
        <div className={`h-full ${color}`} style={{ width: `${p.value ?? 100}%` }} />
      )}
    </div>
  );
}
