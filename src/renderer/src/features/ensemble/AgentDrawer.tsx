import { Hand, MessageSquare, PanelTopOpen, RotateCcw, SquareCheck, X } from 'lucide-react';
import type { EnsembleRecord } from '@shared/domain/ensemble';
import { revealTerminal } from '../attention/reveal';
import { TerminalView } from '../terminals/TerminalView';
import { useTerminalsStore } from '../../stores/terminals-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { ensembleCommand, useEnsembleStore } from './ensemble-store';
import { AgentAvatar, askText, LiveDot, liveLabel, liveOf, modelLabel } from './ui';

/** The real terminal of an agent next to the flow: watch it, type in it (take over), restart it. */
export function AgentDrawer({ record, agentId }: { record: EnsembleRecord; agentId: string }) {
  const { task, run } = record;
  const agent = task.agents.find((a) => a.id === agentId);
  const state = run.agents[agentId];
  const terminalId = state?.terminalId;
  const terminal = useTerminalsStore((s) => (terminalId ? s.terminals[terminalId] : undefined));
  const close = () => useEnsembleStore.getState().setPeek(task.id, null);
  if (!agent) return null;
  const kind = liveOf(state);
  const taken = state?.takenOver ?? false;
  const active = run.status === 'running' || run.status === 'paused';
  return (
    <div
      className="ens-fade-in absolute inset-y-0 right-0 z-20 flex w-[min(720px,62%)] flex-col border-l border-line bg-surface shadow-elevated"
      data-testid="ensemble-drawer"
      data-agent-id={agentId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.xterm')) close();
      }}
    >
      <div className="flex flex-none items-center gap-2 border-b border-line-subtle px-3 py-2">
        <AgentAvatar agent={agent} size={26} pulse={kind === 'working'} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-fg">
            {agent.name} <span className="font-normal text-fg-muted">· {agent.role.label}</span>
          </span>
          <span className="flex items-center gap-1.5 font-mono text-small text-fg-muted">
            <LiveDot kind={kind} size={7} /> {liveLabel(kind)} · {modelLabel(agent)}
            {taken && <span className="text-warning">· you have it</span>}
          </span>
        </div>
        {active && state?.lifecycle === 'running' && (
          <Button
            size="sm"
            data-testid="ensemble-take-over"
            variant={taken ? 'primary' : 'secondary'}
            title={
              taken ? 'Oxytocin delivers to this agent again' : 'Oxytocin delivers nothing to this agent while you type'
            }
            onClick={() => void ensembleCommand(task.id, { type: taken ? 'hand-back' : 'take-over', agentId })}
          >
            <Hand size={12} /> {taken ? 'Hand back' : 'Take over'}
          </Button>
        )}
        {active && (
          <IconButton
            label="Send a message"
            data-testid="ensemble-send-message"
            icon={<MessageSquare size={14} />}
            onClick={() =>
              void askText({
                title: `Message to ${agent.name}`,
                description: 'Delivered when the agent is idle, marked as coming from you.',
                placeholder: 'Your message',
                confirmLabel: 'Send',
              }).then((text) => !!text && ensembleCommand(task.id, { type: 'message', to: agentId, text }))
            }
          />
        )}
        {active && state?.assignment && (
          <IconButton
            label="Mark its part as done"
            icon={<SquareCheck size={14} />}
            onClick={() =>
              void askText({
                title: `Mark ${agent.name}'s part as done`,
                description: 'Your summary is handed on as its result.',
                placeholder: 'What did it produce?',
                confirmLabel: 'Mark as done',
              }).then((summary) => !!summary && ensembleCommand(task.id, { type: 'mark-done', agentId, summary }))
            }
          />
        )}
        {active && (
          <IconButton
            label="Restart the agent"
            icon={<RotateCcw size={14} />}
            onClick={() => void ensembleCommand(task.id, { type: 'restart-agent', agentId })}
          />
        )}
        {terminalId && terminal && (
          <IconButton
            label="Open as tab"
            icon={<PanelTopOpen size={14} />}
            onClick={() => {
              close();
              void revealTerminal(task.projectId, terminalId);
            }}
          />
        )}
        <IconButton label="Close (Esc)" data-testid="ensemble-drawer-close" icon={<X size={14} />} onClick={close} />
      </div>
      <div className="min-h-0 flex-1">
        {terminalId && terminal ? (
          <TerminalView key={terminalId} terminalId={terminalId} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-fg-muted">
            {state?.lifecycle === 'not-started'
              ? `${agent.name} has not started yet.`
              : 'The terminal is gone (Oxytocin was restarted).'}
          </div>
        )}
      </div>
    </div>
  );
}
