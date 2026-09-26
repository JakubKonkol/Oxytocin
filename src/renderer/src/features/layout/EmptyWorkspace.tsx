import type { IWatermarkPanelProps } from 'dockview-react';
import { SquareTerminal } from 'lucide-react';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Kbd } from '../../ui/Kbd';
import { addTerminalPanel } from './workspace-actions';
import { getActiveWorkspace } from './workspace-registry';

/** Watermark shown when a workspace has no panels. */
export function EmptyWorkspace(_props: IWatermarkPanelProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<SquareTerminal size={32} />}
        title="No terminals open"
        description={
          <span>
            Press <Kbd shortcut="Ctrl+Shift+T" /> to open a new terminal.
          </span>
        }
        actions={
          <Button
            variant="primary"
            onClick={() => {
              const ws = getActiveWorkspace();
              if (ws) void addTerminalPanel(ws.api, { projectId: ws.projectId });
            }}
          >
            New terminal
          </Button>
        }
      />
    </div>
  );
}
