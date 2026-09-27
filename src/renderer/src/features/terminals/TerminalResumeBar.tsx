import { History } from 'lucide-react';
import type { ResumeInfo } from '@shared/domain/agent-resume';
import { Button } from '../../ui/Button';

/**
 * Offered under a terminal restored after a restart whose agent session is known (docs/plan/03 §7, M7-T6):
 * types the resume command only when the user asks — agents are never started automatically.
 */
export function TerminalResumeBar({
  resume,
  onResume,
  onDismiss,
}: {
  resume: ResumeInfo;
  onResume: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="terminal-resume-bar"
      className="flex flex-none items-center gap-3 border-t border-line-subtle bg-card px-3 py-1.5 text-small text-fg-secondary"
    >
      <History size={13} className="flex-none text-agent" />
      <span className="min-w-0 flex-1 truncate">
        Resume {resume.agentName} session{' '}
        <code className="font-mono text-fg-muted" data-testid="terminal-resume-command">
          ({resume.command})
        </code>
      </span>
      <Button size="sm" variant="secondary" data-testid="terminal-resume" onClick={onResume}>
        Resume
      </Button>
      <Button size="sm" variant="ghost" data-testid="terminal-resume-dismiss" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
