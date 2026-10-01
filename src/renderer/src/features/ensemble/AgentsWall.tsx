import { Maximize2, Minimize2 } from 'lucide-react';
import { useState } from 'react';
import type { EnsembleRecord } from '@shared/domain/ensemble';
import { cn } from '../../lib/cn';
import { useTerminalsStore } from '../../stores/terminals-store';
import { EmptyState } from '../../ui/EmptyState';
import { IconButton } from '../../ui/IconButton';
import { TerminalView } from '../terminals/TerminalView';
import { AgentAvatar, LiveDot, liveLabel, liveOf, modelLabel } from './ui';

/** Every agent's live terminal at once ("watch everything"); one tile can be enlarged. */
export function AgentsWall({ record }: { record: EnsembleRecord }) {
  const { task, run } = record;
  const terminals = useTerminalsStore((s) => s.terminals);
  const [focused, setFocused] = useState<string | null>(null);
  const tiles = task.agents.filter((a) => {
    const id = run.agents[a.id]?.terminalId;
    return id && terminals[id];
  });
  if (tiles.length === 0)
    return (
      <EmptyState
        className="h-full"
        title="No agent terminal yet"
        description="Agents appear here once the conductor starts them."
      />
    );
  const shown = focused ? tiles.filter((a) => a.id === focused) : tiles;
  return (
    <div
      className={cn('grid h-full min-h-0 gap-2 overflow-auto p-2', !focused && tiles.length > 1 && 'grid-cols-2')}
      style={{ gridAutoRows: focused || tiles.length <= 2 ? '1fr' : 'minmax(260px, 1fr)' }}
      data-testid="ensemble-wall"
    >
      {shown.map((a) => {
        const state = run.agents[a.id];
        const kind = liveOf(state);
        return (
          <div
            key={a.id}
            className="flex min-h-0 flex-col overflow-hidden rounded-card border border-line-subtle bg-card"
            data-testid="ensemble-wall-tile"
          >
            <div className="flex flex-none items-center gap-2 border-b border-line-subtle px-2 py-1">
              <AgentAvatar agent={a} size={18} pulse={kind === 'working'} />
              <span className="min-w-0 flex-1 truncate text-small text-fg">
                {a.name}{' '}
                <span className="text-fg-muted">
                  · {a.role.label} · {modelLabel(a)}
                </span>
              </span>
              <LiveDot kind={kind} size={7} />
              <span className="font-mono text-[10px] text-fg-muted">{liveLabel(kind)}</span>
              <IconButton
                label={focused ? 'Show all' : 'Enlarge'}
                icon={focused ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                onClick={() => setFocused(focused ? null : a.id)}
              />
            </div>
            <div className="min-h-0 flex-1">
              <TerminalView terminalId={state!.terminalId!} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
