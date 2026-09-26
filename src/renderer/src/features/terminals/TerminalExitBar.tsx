import type { TerminalInfo } from '@shared/domain/terminal';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/Button';

/** Bar under an exited/disconnected terminal: "Process exited with code 3" + Restart / Close. */
export function TerminalExitBar({
  info,
  onRestart,
  onClose,
}: {
  info: TerminalInfo;
  onRestart: () => void;
  onClose: () => void;
}) {
  const failed = info.state === 'failed';
  const message = failed
    ? (info.error ?? 'The terminal is disconnected')
    : `Process exited with code ${info.exitCode ?? 0}`;
  const bad = failed || (info.exitCode ?? 0) !== 0;
  return (
    <div
      role="status"
      data-testid="terminal-exit-bar"
      className={cn(
        'flex flex-none items-center gap-3 border-t border-line-subtle px-3 py-1.5 text-small',
        bad ? 'bg-danger/10 text-danger' : 'bg-card text-fg-secondary',
      )}
    >
      <span className="flex-1 truncate">{message}</span>
      <Button size="sm" variant="secondary" onClick={onRestart}>
        Restart
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
