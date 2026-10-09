import { DropdownMenu } from 'radix-ui';
import {
  ArrowDown,
  ArrowUp,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  CloudUpload,
  GitBranch,
  GitBranchPlus,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import type { BranchList, RepoStatus } from '@shared/domain/git';
import { ipc } from '../../lib/ipc-client';
import { confirmDialogEx } from '../../stores/dialog-store';
import { SplitBar } from '../../ui/SplitBar';
import { Tooltip } from '../../ui/Tooltip';
import { gitAction, useGitBusy } from './git-actions';

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-accent-muted';
const menuLabel = 'oxy-label px-2 pt-1.5 pb-1';
const pill =
  'flex h-5 flex-none items-center gap-0.5 rounded-badge px-1 font-mono text-small text-fg-muted hover:bg-card-hover hover:text-fg disabled:opacity-50';

export async function createBranch(projectId: string): Promise<void> {
  const r = await confirmDialogEx({
    title: 'Create a branch',
    description: 'The new branch starts at the current commit and keeps your uncommitted changes.',
    input: { kind: 'text', placeholder: 'feature/my-change' },
    confirmLabel: 'Create and switch',
  });
  if (r.confirmed && r.value?.trim())
    await gitAction(projectId, { kind: 'createBranch', name: r.value.trim().replace(/\s+/g, '-') });
}

export async function stashChanges(projectId: string): Promise<void> {
  const r = await confirmDialogEx({
    title: 'Stash the changes?',
    description:
      'Every change of the project (new files included) is put aside and the files go back to HEAD. Pop the stash to bring them back.',
    input: { kind: 'text', placeholder: 'Message (optional)' },
    confirmLabel: 'Stash',
  });
  if (r.confirmed)
    await gitAction(projectId, { kind: 'stash', ...(r.value?.trim() ? { message: r.value.trim() } : {}) });
}

function BranchMenu({ projectId, status }: { projectId: string; status: RepoStatus }) {
  const b = status.branch;
  const head = b?.detached ? `detached @ ${b.oid?.slice(0, 7) ?? '?'}` : (b?.head ?? 'no branch');
  const [branches, setBranches] = useState<BranchList | null>(null);
  const tooltip = [
    b?.upstream ? `Upstream: ${b.upstream} (↑${b.ahead} ↓${b.behind})` : 'No upstream',
    status.headCommit
      ? `${status.headCommit.oid.slice(0, 7)} ${status.headCommit.subject} · ${new Date(status.headCommit.date).toLocaleString()}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open)
          void ipc
            .invoke('git:branches', { projectId })
            .then(setBranches, () => setBranches({ current: null, local: [], remotes: [], stashes: 0 }));
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="changes-branch-menu"
          title={tooltip}
          className="flex min-w-0 items-center gap-1 rounded-badge px-1 py-0.5 hover:bg-card-hover"
        >
          <GitBranch size={12} className="flex-none text-fg-muted" />
          <span data-testid="changes-branch" className="min-w-0 truncate font-mono text-fg-secondary">
            {head}
          </span>
          <ChevronDown size={11} className="flex-none text-fg-muted" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          data-testid="branch-menu"
          className="z-50 max-h-[60vh] max-w-80 min-w-56 overflow-auto rounded-control border border-line bg-elevated p-1 shadow-lg"
        >
          <DropdownMenu.Item
            data-testid="branch-create"
            className={menuItem}
            onSelect={() => void createBranch(projectId)}
          >
            <GitBranchPlus size={13} className="text-fg-muted" /> Create Branch…
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
          <DropdownMenu.Label className={menuLabel}>Switch to</DropdownMenu.Label>
          {branches === null && <div className="px-2 py-1 text-small text-fg-muted">Loading branches…</div>}
          {branches?.local.map((br) => (
            <DropdownMenu.Item
              key={br.name}
              data-testid={`branch-item-${br.name}`}
              className={menuItem}
              disabled={br.name === branches.current}
              onSelect={() => void gitAction(projectId, { kind: 'checkout', branch: br.name })}
            >
              <Check
                size={13}
                className={br.name === branches.current ? 'flex-none text-accent' : 'invisible flex-none'}
              />
              <span className="min-w-0 flex-1 truncate font-mono">{br.name}</span>
              {br.upstream && (
                <span className="max-w-28 flex-none truncate text-small text-fg-muted">{br.upstream}</span>
              )}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
          <DropdownMenu.Item
            data-testid="branch-stash"
            className={menuItem}
            disabled={status.files.length === 0}
            onSelect={() => void stashChanges(projectId)}
          >
            <Archive size={13} className="text-fg-muted" /> Stash Changes…
          </DropdownMenu.Item>
          <DropdownMenu.Item
            data-testid="branch-stash-pop"
            className={menuItem}
            disabled={!branches || branches.stashes === 0}
            onSelect={() => void gitAction(projectId, { kind: 'stashPop' })}
          >
            <ArchiveRestore size={13} className="text-fg-muted" />
            <span className="flex-1">Pop Stash</span>
            {branches && branches.stashes > 0 && <span className="text-small text-fg-muted">{branches.stashes}</span>}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Pull / push / publish buttons next to the branch: what is ahead and behind the upstream. */
function SyncButtons({ projectId, status }: { projectId: string; status: RepoStatus }) {
  const busy = useGitBusy((s) => s.busy[projectId]);
  const b = status.branch;
  if (!b || b.detached || !status.hasHead) return null;
  const spin = (kind: string) => busy === kind;
  if (!b.upstream)
    return (
      <Tooltip label="Push the branch and set its upstream">
        <button
          type="button"
          data-testid="changes-publish"
          disabled={!!busy}
          className={pill}
          onClick={() => void gitAction(projectId, { kind: 'push' })}
        >
          {spin('push') ? <Loader2 size={11} className="animate-spin" /> : <CloudUpload size={11} />}
          <span className="font-sans">Publish</span>
        </button>
      </Tooltip>
    );
  return (
    <>
      <Tooltip label={`Pull from ${b.upstream}${b.behind ? ` (${b.behind} new)` : ''}`}>
        <button
          type="button"
          data-testid="changes-pull"
          disabled={!!busy}
          className={pill}
          onClick={() => void gitAction(projectId, { kind: 'pull' })}
        >
          {spin('pull') ? <Loader2 size={11} className="animate-spin" /> : <ArrowDown size={11} />}
          {b.behind > 0 && <span className={b.behind > 0 ? 'text-warning' : ''}>{b.behind}</span>}
        </button>
      </Tooltip>
      <Tooltip label={`Push to ${b.upstream}${b.ahead ? ` (${b.ahead} commit${b.ahead === 1 ? '' : 's'})` : ''}`}>
        <button
          type="button"
          data-testid="changes-push"
          disabled={!!busy}
          className={pill}
          onClick={() => void gitAction(projectId, { kind: 'push' })}
        >
          {spin('push') ? <Loader2 size={11} className="animate-spin" /> : <ArrowUp size={11} />}
          {b.ahead > 0 && <span className="text-accent">{b.ahead}</span>}
        </button>
      </Tooltip>
      <Tooltip label="Fetch">
        <button
          type="button"
          data-testid="changes-fetch"
          disabled={!!busy}
          className={pill}
          onClick={() => void gitAction(projectId, { kind: 'fetch' })}
        >
          <RefreshCw size={11} className={spin('fetch') ? 'animate-spin' : ''} />
        </button>
      </Tooltip>
    </>
  );
}

/** Branch (with its menu), sync buttons, totals and the added/deleted bar at the top of the CHANGES section. */
export function BranchBar({ projectId, status }: { projectId: string; status: RepoStatus }) {
  return (
    <div className="flex flex-none flex-col gap-1.5 pt-1.5 pb-2">
      <div className="flex min-w-0 items-center gap-1 text-small">
        <BranchMenu projectId={projectId} status={status} />
        <SyncButtons projectId={projectId} status={status} />
        <span className="flex-1" />
        <span data-testid="changes-totals" className="flex flex-none items-center gap-1 font-mono">
          <span className="text-git-added">+{status.totals.additions}</span>
          <span className="text-git-deleted">−{status.totals.deletions}</span>
          <span className="text-fg-muted">
            · {status.totals.files} file{status.totals.files === 1 ? '' : 's'}
          </span>
        </span>
      </div>
      <SplitBar added={status.totals.additions} deleted={status.totals.deletions} />
    </div>
  );
}
