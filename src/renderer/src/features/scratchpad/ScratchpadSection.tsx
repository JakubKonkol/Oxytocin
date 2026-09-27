import { DropdownMenu } from 'radix-ui';
import { Check, ChevronDown, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useProjectsStore } from '../../stores/projects-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { useUiStore } from '../../stores/ui-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { chooseAgentTarget, currentAgentTarget, sendToAgent } from './scratchpad-actions';
import { type AgentTarget, agentTargets } from './send-target';

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';

/** Running agents, recomputed when terminals or projects change. */
function useAgentTargets(): AgentTarget[] {
  const terminals = useTerminalsStore((s) => s.terminals);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  return agentTargets(terminals, projects, activeId);
}

export function ScratchpadHeaderActions() {
  const empty = useUiStore((s) => s.state.scratchpad.text.length === 0);
  return (
    <IconButton
      label="Clear scratchpad"
      icon={<Trash2 size={13} />}
      disabled={empty}
      onClick={() => useUiStore.getState().setScratchpadText('')}
    />
  );
}

/** Notes and prompt drafts (persisted in ui-state.json) with "Send to agent". */
export function ScratchpadSection() {
  const text = useUiStore((s) => s.state.scratchpad.text);
  const setText = useUiStore((s) => s.setScratchpadText);
  const targets = useAgentTargets();
  // Re-render after choosing a target in the menu (the choice lives outside React).
  const [, setChoice] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const target = currentAgentTarget(targets);
  const canSend = text.trim().length > 0 && targets.length > 0;

  const send = (to: AgentTarget | null = target) => {
    if (!canSend) return;
    if (!to) {
      setMenuOpen(true);
      return;
    }
    void sendToAgent(to, text);
  };

  const hint =
    targets.length === 0
      ? 'No agent is running'
      : target
        ? `Paste into ${target.label}`
        : 'Choose the agent to paste into';

  return (
    <div className="flex h-full flex-col rounded-b-card border border-t-0 border-line-subtle bg-card px-2 pb-2">
      <textarea
        data-testid="scratchpad-input"
        aria-label="Scratchpad"
        placeholder="Notes and prompt drafts…"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
        className="min-h-0 flex-1 resize-none rounded-control border border-line bg-input p-2 font-mono text-small text-fg outline-none placeholder:text-fg-muted focus:border-accent"
      />
      <div className="mt-2 flex flex-none items-center gap-1">
        <Tooltip label={hint} shortcut="Ctrl+Enter">
          <Button
            data-testid="scratchpad-send"
            variant="primary"
            size="sm"
            className={canSend ? 'min-w-0 flex-1' : 'min-w-0 flex-1 opacity-50'}
            aria-disabled={!canSend}
            onClick={() => send()}
          >
            <Send size={12} className="flex-none" />
            <span className="truncate">{target ? `Send to ${target.label}` : 'Send to agent'}</span>
          </Button>
        </Tooltip>
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <IconButton
              data-testid="scratchpad-target"
              label="Choose agent"
              icon={<ChevronDown size={14} />}
              disabled={targets.length === 0}
            />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 max-w-80 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-lg"
            >
              <DropdownMenu.Label className="px-2 py-1 text-small text-fg-muted">Send to</DropdownMenu.Label>
              {targets.map((t) => (
                <DropdownMenu.Item
                  key={t.terminalId}
                  data-testid={`scratchpad-target-${t.terminalId}`}
                  className={menuItem}
                  onSelect={() => {
                    chooseAgentTarget(t.terminalId);
                    setChoice((n) => n + 1);
                    send(t);
                  }}
                >
                  <Check
                    size={12}
                    className={t.terminalId === target?.terminalId ? 'flex-none' : 'invisible flex-none'}
                  />
                  <span className="truncate">{t.label}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
