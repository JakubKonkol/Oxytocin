import { DropdownMenu } from 'radix-ui';
import {
  Bot,
  Check,
  ChevronDown,
  ClipboardCopy,
  FileCode2,
  GitCompare,
  NotebookPen,
  Send,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { useProjectsStore } from '../../stores/projects-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { Button } from '../../ui/Button';
import { AppDialog } from '../../ui/Dialog';
import { notify } from '../../ui/Toast';
import {
  appendToScratchpad,
  chooseAgentTarget,
  currentAgentTarget,
  sendToAgent,
} from '../scratchpad/scratchpad-actions';
import { type AgentTarget, agentTargets } from '../scratchpad/send-target';
import { type AskAgentRequest, useAskAgentStore } from './ask-agent-store';
import { buildPrompt, lineRange, type PromptContext, presetInstruction, PROMPT_PRESETS } from './prompt-model';

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';

function ContextCard({ context }: { context: PromptContext }) {
  const [open, setOpen] = useState(true);
  if (context.kind === 'file')
    return (
      <div className="flex items-center gap-2 rounded-control border border-line-subtle bg-card px-2.5 py-1.5">
        <FileCode2 size={13} className="flex-none text-fg-muted" />
        <span className="min-w-0 truncate font-mono text-small text-fg">{context.path}</span>
        <span className="flex-none rounded-badge bg-input px-1.5 text-small text-fg-muted">whole file</span>
      </div>
    );
  if (context.kind === 'changes')
    return (
      <div className="flex items-center gap-2 rounded-control border border-line-subtle bg-card px-2.5 py-1.5">
        <GitCompare size={13} className="flex-none text-git-modified" />
        <span className="min-w-0 truncate font-mono text-small text-fg">{context.changes.path}</span>
        <span className="flex-none rounded-badge bg-input px-1.5 text-small text-fg-muted">uncommitted changes</span>
      </div>
    );
  const c = context.code;
  return (
    <div className="overflow-hidden rounded-control border border-line-subtle bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-card-hover"
      >
        <FileCode2 size={13} className="flex-none text-fg-muted" />
        <span className="min-w-0 truncate font-mono text-small text-fg">{c.path}</span>
        <span className="flex-none text-small text-fg-muted">{lineRange(c.startLine, c.endLine)}</span>
        {c.original && <span className="flex-none rounded-badge bg-input px-1.5 text-small text-fg-muted">HEAD</span>}
        <span className="flex-1" />
        <ChevronDown size={12} className={cn('flex-none text-fg-muted transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <pre
          data-testid="ask-agent-code"
          className="max-h-40 overflow-auto border-t border-line-subtle bg-input px-2.5 py-1.5 font-mono text-small leading-relaxed whitespace-pre text-fg-secondary select-text"
        >
          {c.code}
        </pre>
      )}
    </div>
  );
}

function useTargets(): AgentTarget[] {
  const terminals = useTerminalsStore((s) => s.terminals);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  return useMemo(() => agentTargets(terminals, projects, activeId), [terminals, projects, activeId]);
}

function AskAgentDialog({ request }: { request: AskAgentRequest }) {
  const close = useAskAgentStore((s) => s.close);
  const targets = useTargets();
  const submitSetting = useSettingsStore((s) => s.settings?.['editor.askAgent.submit'] ?? true);
  const initialPreset = PROMPT_PRESETS.find((p) => p.id === request.presetId);
  const [presetId, setPresetId] = useState<string | null>(request.text ? null : (initialPreset?.id ?? null));
  const [instruction, setInstruction] = useState(
    request.text ?? (initialPreset ? presetInstruction(initialPreset, request.contexts) : ''),
  );
  const [target, setTarget] = useState<AgentTarget | null>(() => currentAgentTarget(targets));
  const [submit, setSubmit] = useState(submitSetting);
  const chosen = target && targets.some((t) => t.terminalId === target.terminalId) ? target : null;
  const prompt = buildPrompt(instruction, request.contexts);
  const canSend = instruction.trim().length > 0 && chosen !== null;

  const send = async () => {
    if (!canSend || !chosen) return;
    chooseAgentTarget(chosen.terminalId);
    if (submit !== submitSetting) void ipc.invoke('settings:update', { 'editor.askAgent.submit': submit });
    close();
    if (await sendToAgent(chosen, prompt, { submit })) request.onSent?.();
  };

  return (
    <AppDialog
      testId="ask-agent-dialog"
      title="Ask agent"
      icon={<Sparkles size={16} className="flex-none text-agent" />}
      onClose={close}
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            data-testid="ask-agent-copy"
            disabled={!instruction.trim()}
            onClick={() => {
              void ipc.invoke('clipboard:writeText', { text: prompt });
              notify('success', 'Prompt copied');
              close();
            }}
          >
            <ClipboardCopy size={12} /> Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="ask-agent-scratchpad"
            disabled={!instruction.trim()}
            onClick={() => {
              appendToScratchpad(prompt);
              notify('success', 'Added to the scratchpad');
              close();
            }}
          >
            <NotebookPen size={12} /> Add to scratchpad
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="ask-agent-send"
            disabled={!canSend}
            onClick={() => void send()}
          >
            <Send size={12} /> {submit ? 'Send' : 'Paste'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5" data-testid="ask-agent-contexts">
          {request.contexts.map((c, i) => (
            <ContextCard key={i} context={c} />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="oxy-label">What should the agent do?</div>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Presets">
            {PROMPT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={presetId === p.id}
                data-testid={`ask-agent-preset-${p.id}`}
                onClick={() => {
                  setPresetId(p.id);
                  setInstruction(presetInstruction(p, request.contexts));
                }}
                className={cn(
                  'h-6 rounded-full border px-2.5 text-small transition-colors',
                  presetId === p.id
                    ? 'border-accent bg-accent-muted text-fg'
                    : 'border-line-subtle text-fg-secondary hover:bg-card-hover hover:text-fg',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            data-testid="ask-agent-input"
            autoFocus
            rows={4}
            value={instruction}
            placeholder="Describe what to do with this code…"
            onChange={(e) => {
              setInstruction(e.target.value);
              setPresetId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            className="resize-y rounded-control border border-line bg-input p-2 text-ui text-fg outline-none select-text placeholder:text-fg-muted focus:border-accent"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="oxy-label">Agent</span>
          {targets.length === 0 ? (
            <span data-testid="ask-agent-no-agent" className="text-small text-warning">
              No agent is running — start one in a terminal, or copy the prompt.
            </span>
          ) : (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm" variant="secondary" data-testid="ask-agent-target" className="max-w-72">
                  <Bot size={12} className="flex-none text-agent" />
                  <span className="truncate">{chosen?.label ?? 'Choose an agent'}</span>
                  <ChevronDown size={12} className="flex-none text-fg-muted" />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={4}
                  className="z-50 max-w-80 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-lg"
                >
                  {targets.map((t) => (
                    <DropdownMenu.Item
                      key={t.terminalId}
                      data-testid={`ask-agent-target-${t.terminalId}`}
                      className={menuItem}
                      onSelect={() => setTarget(t)}
                    >
                      <Check
                        size={12}
                        className={t.terminalId === chosen?.terminalId ? 'flex-none' : 'invisible flex-none'}
                      />
                      <span className="truncate">{t.label}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 text-small text-fg-secondary">
            <input
              type="checkbox"
              data-testid="ask-agent-submit"
              checked={submit}
              onChange={(e) => setSubmit(e.target.checked)}
              className="accent-(--accent)"
            />
            Send right away
          </label>
        </div>
      </div>
    </AppDialog>
  );
}

/** Renders the "Ask agent" dialog when one was requested (`askAgent`). */
export function AskAgentHost() {
  const request = useAskAgentStore((s) => s.request);
  return request ? <AskAgentDialog key={request.id} request={request} /> : null;
}
