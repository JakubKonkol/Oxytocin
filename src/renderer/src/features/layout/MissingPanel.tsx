import type { IDockviewPanelProps } from 'dockview-react';
import { PuzzleIcon } from 'lucide-react';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import type { MissingPanelParams } from './panel-registry';

/** Placeholder for a restored panel whose type is unavailable (e.g. an uninstalled plugin). */
export function MissingPanel(props: IDockviewPanelProps<MissingPanelParams>) {
  return (
    <div className="flex h-full items-center justify-center bg-card" data-testid="missing-panel">
      <EmptyState
        icon={<PuzzleIcon size={28} />}
        title={props.params.reason}
        actions={
          <Button variant="secondary" onClick={() => props.api.close()}>
            Close
          </Button>
        }
      />
    </div>
  );
}
