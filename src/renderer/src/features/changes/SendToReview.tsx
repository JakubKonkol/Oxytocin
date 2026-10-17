import { Bot, Loader2, Send, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { agentLaunchers } from '@shared/domain/agent-launch';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { useSettingsStore } from '../../stores/settings-store';
import { AppDialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { notify } from '../../ui/Toast';
import { useAiAgentsStore } from '../ai-agents/ai-agents-store';
import { input } from '../projects/settings/controls';

function ReviewDialog({ projectId, count, close }: { projectId: string; count: number; close: () => void }) {
  const state = useAiAgentsStore((s) => s.state);
  const ensure = useAiAgentsStore((s) => s.ensure);
  const defaultPrompt = useSettingsStore((s) => s.settings?.['git.reviewPrompt'] ?? '');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [launchId, setLaunchId] = useState('');
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const entries = agentLaunchers(state);
  const selected = launchId || entries[0]?.launchId || '';
  useEffect(() => {
    void ensure();
  }, [ensure]);
  const send = async () => {
    setSending(true);
    setError('');
    try {
      const result = await ipc.invoke('aiAgents:launch', { projectId, launchId: selected, prompt });
      if (!result.sent) {
        setError(result.error ?? 'Open the terminal and retry when the agent is ready.');
        return;
      }
      notify('success', 'Changes sent for review');
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  const savePrompt = async () => {
    try {
      await ipc.invoke('settings:update', { 'git.reviewPrompt': prompt });
      notify('success', 'Default review instruction saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <AppDialog
      title="Send changes to review"
      icon={<Bot size={18} className="text-agent" />}
      testId="changes-send-review-dialog"
      onClose={() => {
        if (!sending) close();
      }}
      footer={
        <>
          <span className="flex-1 text-small text-fg-muted">
            {count} changed file{count === 1 ? '' : 's'}
          </span>
          <Button disabled={sending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="changes-send-review-confirm"
            disabled={sending || !selected || !prompt.trim()}
            onClick={() => void send()}
          >
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}{' '}
            {sending ? 'Opening agent…' : 'Send to review'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-small text-fg-muted">
          The agent reviews the current staged, unstaged and untracked changes in this project. A matching terminal is
          reused; otherwise a new one opens.
        </p>
        <label className="flex flex-col gap-1.5 text-small text-fg-secondary">
          Review agent
          <select
            className={input}
            aria-label="Review agent"
            data-testid="changes-review-agent"
            value={selected}
            onChange={(e) => setLaunchId(e.target.value)}
            disabled={sending}
          >
            {!entries.length && <option value="">Configure agents in Settings → AI Agents</option>}
            {entries.map((a) => (
              <option key={a.launchId} value={a.launchId}>
                {a.name}
                {a.detail ? ` · ${a.detail}` : ''}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setEditing(!editing)}>
          <Settings2 size={13} />
          Review instruction
        </Button>
        {editing ? (
          <>
            <textarea
              aria-label="Review instruction"
              data-testid="changes-review-prompt"
              className={cn(input, 'min-h-28 resize-y')}
              maxLength={8000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={sending}
            />
            <Button
              className="self-start"
              size="sm"
              disabled={sending || !prompt.trim()}
              onClick={() => void savePrompt()}
            >
              Save as default
            </Button>
          </>
        ) : (
          <p className="rounded-control border border-line-subtle bg-input p-3 text-small leading-relaxed text-fg-secondary">
            {prompt}
          </p>
        )}
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
      </div>
    </AppDialog>
  );
}

export function SendToReview({ projectId, count }: { projectId: string; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex flex-none items-center justify-between gap-2 border-b border-line-subtle bg-card px-2 py-2">
        <span className="text-small text-fg-muted">
          {count} changed file{count === 1 ? '' : 's'}
        </span>
        <Button size="sm" data-testid="changes-send-review" disabled={count === 0} onClick={() => setOpen(true)}>
          <Bot size={13} /> Send to review
        </Button>
      </div>
      {open && <ReviewDialog key={projectId} projectId={projectId} count={count} close={() => setOpen(false)} />}
    </>
  );
}
