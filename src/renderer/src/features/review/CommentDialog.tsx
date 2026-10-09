import { MessageSquarePlus } from 'lucide-react';
import { useState } from 'react';
import { create } from 'zustand';
import { Button } from '../../ui/Button';
import { AppDialog } from '../../ui/Dialog';
import { notify } from '../../ui/Toast';
import { type CodeContext, lineRange } from '../ask-agent/prompt-model';
import { useReviewStore } from './review-store';

interface Draft {
  key: number;
  projectId: string;
  code: CodeContext;
}

const useDraft = create<{ draft: Draft | null }>(() => ({ draft: null }));
let key = 1;

/** Opens the dialog that adds a review comment on a line range. */
export function addReviewComment(projectId: string, code: CodeContext): void {
  useDraft.setState({ draft: { key: key++, projectId, code } });
}

function CommentDialog({ draft }: { draft: Draft }) {
  const [text, setText] = useState('');
  const close = () => useDraft.setState({ draft: null });
  const save = () => {
    if (!text.trim()) return;
    const { code } = draft;
    useReviewStore.getState().add(draft.projectId, {
      path: code.path,
      startLine: code.startLine,
      endLine: code.endLine,
      code: code.code,
      languageId: code.languageId,
      ...(code.original ? { original: true } : {}),
      text: text.trim(),
    });
    close();
    const count = useReviewStore.getState().comments[draft.projectId]?.length ?? 0;
    notify('success', `Review comment added (${count} in the review)`);
  };
  return (
    <AppDialog
      testId="review-comment-dialog"
      title="Add review comment"
      icon={<MessageSquarePlus size={16} className="flex-none text-accent" />}
      onClose={close}
      footer={
        <>
          <span className="text-small text-fg-muted">Comments are sent to an agent together from the Review.</span>
          <span className="flex-1" />
          <Button size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" data-testid="review-comment-save" disabled={!text.trim()} onClick={save}>
            Add comment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-small">
          <span className="min-w-0 truncate font-mono text-fg">{draft.code.path}</span>
          <span className="flex-none text-fg-muted">{lineRange(draft.code.startLine, draft.code.endLine)}</span>
          {draft.code.original && <span className="rounded-badge bg-input px-1.5 text-fg-muted">HEAD</span>}
        </div>
        <pre className="max-h-40 overflow-auto rounded-control border border-line-subtle bg-input px-2.5 py-1.5 font-mono text-small leading-relaxed whitespace-pre text-fg-secondary select-text">
          {draft.code.code}
        </pre>
        <textarea
          data-testid="review-comment-input"
          autoFocus
          rows={4}
          value={text}
          placeholder="What should change here? (Ctrl+Enter to add)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          }}
          className="resize-y rounded-control border border-line bg-input p-2 text-ui text-fg outline-none placeholder:text-fg-muted focus:border-accent"
        />
      </div>
    </AppDialog>
  );
}

export function CommentDialogHost() {
  const draft = useDraft((s) => s.draft);
  return draft ? <CommentDialog key={draft.key} draft={draft} /> : null;
}
