import { Dialog } from 'radix-ui';
import { CheckCircle2, Pencil, ShieldQuestion, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { EnsembleChange, EnsembleRecord, Handoff } from '@shared/domain/ensemble';
import { OUTPUT_LABELS } from '@shared/domain/ensemble';
import { nameOf } from '@shared/ensemble/context';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { ensembleCommand } from './ensemble-store';
import { Markdown } from './ui';

export function EnsembleDialog({
  title,
  icon,
  children,
  footer,
  onClose,
  testId,
  wide,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  testId: string;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oxy-dialog-overlay fixed inset-0 z-40 bg-app/70 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid={testId}
          aria-describedby={undefined}
          className={cn(
            'oxy-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-line bg-elevated shadow-elevated',
            wide ? 'w-[860px]' : 'w-[560px]',
          )}
        >
          <div className="flex flex-none items-center gap-2.5 border-b border-line-subtle px-4 py-3">
            {icon}
            <Dialog.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{title}</Dialog.Title>
            <IconButton label="Close" icon={<X size={14} />} onClick={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
          {footer && (
            <div className="flex flex-none items-center gap-2 border-t border-line-subtle bg-card px-4 py-3">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HandoffBlock({ record, handoff, title }: { record: EnsembleRecord; handoff: Handoff; title?: string }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="oxy-label">
        {title ?? `${OUTPUT_LABELS[handoff.kind]} · ${nameOf(record.task, handoff.agentId)}`}
        {handoff.round ? ` · round ${handoff.round}` : ''}
      </h3>
      <div className="rounded-control border border-line-subtle bg-card p-3">
        <p className="mb-2 font-medium text-fg">{handoff.summary}</p>
        {handoff.verdict && (
          <p
            className={cn(
              'mb-2 text-small font-medium',
              handoff.verdict === 'approve' ? 'text-success' : 'text-warning',
            )}
          >
            Verdict: {handoff.verdict === 'approve' ? 'approved' : 'changes requested'}
          </p>
        )}
        {handoff.findings && handoff.findings.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1">
            {handoff.findings.map((f, i) => (
              <li key={i} className="flex gap-2 text-small">
                <span className="flex-none rounded-badge border border-line px-1 font-mono text-[10px] uppercase text-fg-secondary">
                  {f.severity}
                </span>
                <span className="text-fg">
                  {f.file && (
                    <span className="font-mono text-fg-secondary">
                      {f.file}
                      {f.line ? `:${f.line}` : ''} —{' '}
                    </span>
                  )}
                  {f.message}
                </span>
              </li>
            ))}
          </ul>
        )}
        {handoff.body && handoff.body.trim() !== handoff.summary.trim() && <Markdown text={handoff.body} />}
      </div>
    </section>
  );
}

/** A gate: shows what the stage asks to approve; approve, request changes (with a comment), edit the plan or stop. */
export function GateDialog({
  record,
  stageId,
  onClose,
}: {
  record: EnsembleRecord;
  stageId: string;
  onClose: () => void;
}) {
  const { task, run } = record;
  const stage = task.pipeline.find((s) => s.id === stageId);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const plan = [...run.handoffs].reverse().find((h) => h.kind === 'plan');
  const [edited, setEdited] = useState(plan?.body ?? plan?.summary ?? '');
  const [changes, setChanges] = useState<EnsembleChange[] | null>(null);
  const show = useMemo(() => (stage?.kind === 'gate' ? stage.show : []), [stage]);
  const open = run.stages.find((s) => s.stageId === stageId)?.status === 'waiting-gate';

  useEffect(() => {
    if (!show.includes('diff')) return;
    void ipc.invoke('ensemble:changes', { taskId: task.id }).then(setChanges, () => setChanges([]));
  }, [show, task.id]);

  if (!stage || stage.kind !== 'gate') return null;
  const decide = async (decision: 'approve' | 'reject' | 'stop') => {
    const ok = await ensembleCommand(task.id, {
      type: 'gate',
      stageId,
      decision,
      ...(decision === 'reject' && comment.trim() ? { comment: comment.trim() } : {}),
      ...(decision === 'approve' && editing && edited.trim() ? { editedBody: edited } : {}),
    });
    if (ok) onClose();
  };
  const latest = (kind: Handoff['kind']) => [...run.handoffs].reverse().find((h) => h.kind === kind);
  const reviews = (() => {
    const out = new Map<string, Handoff>();
    for (const h of run.handoffs) if (h.kind === 'review') out.set(h.agentId, h);
    return [...out.values()];
  })();
  const tests = [...run.handoffs].reverse().find((h) => h.agentId === 'conductor');
  const advice = [...run.advice].reverse().find((a) => a.stageId === stageId && a.target === 'user' && a.advice);
  const last = [...run.handoffs].reverse().find((h) => h.by !== 'conductor');

  return (
    <EnsembleDialog
      testId="ensemble-gate-dialog"
      wide
      title={stage.title}
      icon={<ShieldQuestion size={18} className="text-accent" />}
      onClose={onClose}
      footer={
        <>
          <textarea
            data-testid="ensemble-gate-comment"
            value={comment}
            rows={2}
            disabled={!open}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Comments for the agent (sent with “Request changes”)"
            className="min-w-0 flex-1 resize-none rounded-control border border-line bg-input p-2 text-ui text-fg placeholder:text-fg-muted"
          />
          <div className="flex flex-none flex-col gap-1.5">
            <Button
              variant="primary"
              data-testid="ensemble-gate-approve"
              disabled={!open}
              onClick={() => void decide('approve')}
            >
              <CheckCircle2 size={14} /> {editing ? 'Save and approve' : 'Approve'}
            </Button>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                data-testid="ensemble-gate-reject"
                disabled={!open || (stage.onReject === 'back-to-previous' && !comment.trim())}
                title={
                  stage.onReject === 'back-to-previous'
                    ? 'Sends your comments back to the previous stage'
                    : 'Stops the task'
                }
                onClick={() => void decide('reject')}
              >
                Request changes
              </Button>
              <Button size="sm" variant="ghost" disabled={!open} onClick={() => void decide('stop')}>
                Stop task
              </Button>
            </div>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!open && <p className="text-small text-fg-muted">This gate is not open any more.</p>}
        {advice?.advice && (
          <section className="rounded-control border border-agent/40 bg-agent/10 p-3">
            <h3 className="oxy-label mb-1 text-agent">The advisor suggests looking at</h3>
            <Markdown text={advice.advice} />
          </section>
        )}
        {show.includes('plan') && plan && (
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center">
              <h3 className="oxy-label flex-1">
                Plan · {nameOf(task, plan.agentId)}
                {plan.by === 'user' ? ' (edited)' : ''}
              </h3>
              <Button
                size="sm"
                variant="ghost"
                data-testid="ensemble-gate-edit"
                disabled={!open}
                onClick={() => setEditing((e) => !e)}
              >
                <Pencil size={12} /> {editing ? 'Preview' : 'Edit'}
              </Button>
            </div>
            {editing ? (
              <textarea
                data-testid="ensemble-gate-plan-editor"
                value={edited}
                onChange={(e) => setEdited(e.target.value)}
                rows={16}
                className="w-full resize-y rounded-control border border-line bg-input p-2 font-mono text-ui text-fg"
              />
            ) : (
              <div className="rounded-control border border-line-subtle bg-card p-3">
                <Markdown text={plan.body?.trim() ? plan.body : plan.summary} />
              </div>
            )}
          </section>
        )}
        {show.includes('review') && reviews.map((r) => <HandoffBlock key={r.id} record={record} handoff={r} />)}
        {show.includes('tests') && tests && <HandoffBlock record={record} handoff={tests} title="Tests" />}
        {show.includes('diff') && (
          <section className="flex flex-col gap-1.5" data-testid="ensemble-gate-diff">
            <h3 className="oxy-label">Changes ({changes?.length ?? '…'})</h3>
            <div className="rounded-control border border-line-subtle bg-card p-2 font-mono text-small">
              {changes === null && <span className="text-fg-muted">Loading…</span>}
              {changes?.length === 0 && <span className="text-fg-muted">No changes.</span>}
              {changes?.map((c) => (
                <div key={c.path} className="flex gap-2">
                  <span className="w-4 flex-none text-fg-muted">{c.status[0]!.toUpperCase()}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{c.path}</span>
                  {c.additions !== undefined && <span className="text-git-added">+{c.additions}</span>}
                  {c.deletions !== undefined && <span className="text-git-deleted">−{c.deletions}</span>}
                </div>
              ))}
            </div>
            <p className="text-small text-fg-muted">The Changes tab shows every diff.</p>
          </section>
        )}
        {(show.includes('summary') || show.length === 0) && last && (
          <HandoffBlock record={record} handoff={last} title="Latest result" />
        )}
        {show.includes('summary') && latest('implementation') && latest('implementation') !== last && (
          <HandoffBlock record={record} handoff={latest('implementation')!} />
        )}
      </div>
    </EnsembleDialog>
  );
}
