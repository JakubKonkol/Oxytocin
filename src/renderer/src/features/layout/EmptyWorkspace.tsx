import type { IWatermarkPanelProps } from 'dockview-react';
import { Bot, ChevronDown, SquareTerminal } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Kbd } from '../../ui/Kbd';
import { menuEntries } from '../ai-agents/ai-agents-model';
import { useAiAgentsStore } from '../ai-agents/ai-agents-store';
import { WorkspaceAddMenu } from '../tools/AddMenus';
import { addTerminalPanel } from './workspace-actions';
import { getActiveWorkspace } from './workspace-registry';

/** AI agents offered as buttons; the rest are in "Open…". */
const QUICK_AGENTS = 4;

/**
 * Watermark shown when a workspace has no panels: a terminal, an AI agent directly, or anything else from the same
 * choices as a group's "+" (terminal profiles, agents, tools).
 */
export function EmptyWorkspace({ containerApi }: IWatermarkPanelProps) {
  const aiState = useAiAgentsStore((s) => s.state);
  const agents = menuEntries(aiState).slice(0, QUICK_AGENTS);
  useEffect(() => {
    void useAiAgentsStore.getState().ensure();
  }, []);
  const projectId = () => getActiveWorkspace()?.projectId;
  const open = (profileId?: string) => {
    const p = projectId();
    if (p) void addTerminalPanel(containerApi, { projectId: p, ...(profileId ? { profileId } : {}) });
  };
  return (
    <div className="flex h-full items-center justify-center" data-testid="empty-workspace">
      <EmptyState
        icon={<SquareTerminal size={32} />}
        title="Nothing open in this project"
        description={
          <span>
            Open a terminal, an AI agent or a tool. <Kbd shortcut="Ctrl+Shift+T" /> opens a new terminal.
          </span>
        }
        actions={
          <div className="flex max-w-xl flex-wrap justify-center gap-2">
            <Button variant="primary" data-testid="empty-new-terminal" onClick={() => open()}>
              New terminal
            </Button>
            {agents.map((a) => (
              <Button
                key={a.launchId}
                data-testid={`empty-ai-${a.launchId}`}
                title={a.detail ? `${a.name} (${a.detail})` : a.name}
                onClick={() => open(a.launchId)}
              >
                <Bot size={14} className="flex-none text-agent" />
                <span className="max-w-48 truncate">{a.name}</span>
              </Button>
            ))}
            <WorkspaceAddMenu
              api={containerApi}
              projectId={projectId}
              align="center"
              trigger={
                <Button data-testid="empty-open-menu">
                  Open…
                  <ChevronDown size={14} className="flex-none text-fg-muted" />
                </Button>
              }
            />
          </div>
        }
      />
    </div>
  );
}
