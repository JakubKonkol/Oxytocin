import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, CloudUpload, Loader2, PencilLine, Undo2 } from 'lucide-react';
import { useRef } from 'react';
import type { RepoStatus } from '@shared/domain/git';
import { cn } from '../../lib/cn';
import { useChangesStore } from '../../stores/changes-store';
import { Tooltip } from '../../ui/Tooltip';
import { gitAction, undoLastCommit, useGitBusy } from './git-actions';

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-accent-muted';

/** What a commit would contain: the staged files, or (nothing staged) every change. */
export function commitScope(status: Pick<RepoStatus, 'files'>): { staged: number; total: number } {
  return { staged: status.files.filter((f) => f.staged).length, total: status.files.length };
}

/**
 * The commit message and the Commit button of the CHANGES section. With nothing staged, Commit stages every change
 * first (like most git GUIs); the menu adds Commit & Push, Amend and Undo Last Commit.
 */
export function CommitBox({ projectId, status }: { projectId: string; status: RepoStatus }) {
  const message = useChangesStore((s) => s.commitMessage[projectId] ?? '');
  const setMessage = (m: string) => useChangesStore.getState().setCommitMessage(projectId, m);
  const busy = useGitBusy((s) => s.busy[projectId]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { staged, total } = commitScope(status);
  const branch = status.branch?.head ?? (status.branch?.detached ? 'detached HEAD' : 'HEAD');
  const canCommit = total > 0 && message.trim().length > 0 && !busy;

  const commit = async (opts: { push?: boolean; amend?: boolean } = {}) => {
    if (busy) return;
    if (!opts.amend && (!message.trim() || total === 0)) {
      ref.current?.focus();
      return;
    }
    const result = await gitAction(projectId, {
      kind: 'commit',
      message,
      ...(opts.amend ? { amend: true } : {}),
      ...(staged === 0 && total > 0 ? { stageAll: true } : {}),
    });
    if (!result) return;
    setMessage('');
    if (opts.push) await gitAction(projectId, { kind: 'push' });
  };

  const label = staged > 0 ? `Commit ${staged} staged` : total > 0 ? `Commit all ${total}` : 'Commit';
  const lines = Math.min(6, Math.max(1, message.split('\n').length));
  return (
    <div className="flex flex-none flex-col gap-1.5 pb-2" data-testid="commit-box">
      <textarea
        ref={ref}
        data-testid="commit-message"
        aria-label="Commit message"
        rows={lines}
        value={message}
        placeholder={`Message (Ctrl+Enter to commit on ${branch})`}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void commit();
          }
        }}
        className="min-h-7 resize-none rounded-control border border-line bg-input px-2 py-1 text-ui leading-snug text-fg outline-none placeholder:text-fg-muted focus:border-accent"
      />
      <div className="flex h-7 items-stretch">
        <Tooltip
          label={staged > 0 ? 'Commits the staged changes' : 'Stages and commits every change'}
          shortcut="Ctrl+Enter"
        >
          <button
            type="button"
            data-testid="commit-button"
            aria-disabled={!canCommit}
            onClick={() => void commit()}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-control bg-accent px-2 text-ui font-medium text-fg-inverse transition-[filter] hover:brightness-110',
              !canCommit && 'opacity-50',
            )}
          >
            {busy === 'commit' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            <span className="truncate">{label}</span>
          </button>
        </Tooltip>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-testid="commit-menu"
              aria-label="More commit actions"
              className="flex w-7 flex-none items-center justify-center rounded-r-control border-l border-fg-inverse/20 bg-accent text-fg-inverse hover:brightness-110"
            >
              <ChevronDown size={13} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 min-w-56 rounded-control border border-line bg-elevated p-1 shadow-lg"
            >
              <DropdownMenu.Item className={menuItem} disabled={!canCommit} onSelect={() => void commit()}>
                <Check size={13} className="text-fg-muted" /> {label}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="commit-and-push"
                className={menuItem}
                disabled={!canCommit}
                onSelect={() => void commit({ push: true })}
              >
                <CloudUpload size={13} className="text-fg-muted" /> Commit & Push
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-testid="commit-amend"
                className={menuItem}
                disabled={!status.hasHead || !!busy}
                onSelect={() => void commit({ amend: true })}
              >
                <PencilLine size={13} className="text-fg-muted" />
                {message.trim() ? 'Amend Last Commit (new message)' : 'Amend Last Commit'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
              <DropdownMenu.Item
                data-testid="commit-undo"
                className={menuItem}
                disabled={!status.hasHead || !!busy}
                onSelect={() => void undoLastCommit(projectId, status.headCommit?.subject)}
              >
                <Undo2 size={13} className="text-fg-muted" /> Undo Last Commit
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
