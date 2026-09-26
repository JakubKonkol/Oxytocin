import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { useTerminalsStore } from '../../stores/terminals-store';
import { StatusDot } from '../../ui/StatusDot';
import { BellIndicator, TerminalKindBadge } from '../terminals/TerminalBadges';
import { terminalDotLabel, terminalDotState } from '../terminals/terminal-status';
import type { TerminalPanelParams } from './panel-registry';
import { requestClosePanel } from './workspace-actions';

function useIsActive(props: IDockviewPanelHeaderProps): boolean {
  const [active, setActive] = useState(props.api.isActive);
  useEffect(() => {
    const d = props.api.onDidActiveChange((e) => setActive(e.isActive));
    return () => d.dispose();
  }, [props.api]);
  return active;
}

function TerminalTabContent({ props }: { props: IDockviewPanelHeaderProps<TerminalPanelParams> }) {
  const info = useTerminalsStore((s) => s.terminals[props.params.terminalId]);
  const title = info?.title ?? props.api.title ?? 'Terminal';
  useEffect(() => {
    if (props.api.title !== title) props.api.setTitle(title);
  }, [props.api, title]);
  return (
    <>
      {info && <StatusDot state={terminalDotState(info)} title={terminalDotLabel(info)} size={7} />}
      <span data-testid="tab-title" className="min-w-0 truncate">
        {title}
      </span>
      {info && <TerminalKindBadge info={info} />}
      {info && <BellIndicator info={info} />}
    </>
  );
}

/** Tab / card header of a center panel: status dot, title, kind badge, bell and close. */
export function OxyTab(props: IDockviewPanelHeaderProps) {
  const active = useIsActive(props);
  const isTerminal = props.api.component === 'terminal';
  return (
    <div
      data-testid={`tab-${props.api.id}`}
      data-active={active}
      className={cn(
        'group/tab flex h-full min-w-0 items-center gap-2 pr-1 pl-3 text-ui',
        active ? 'text-fg' : 'text-fg-secondary',
      )}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void requestClosePanel(props.containerApi, props.api.id);
        }
      }}
    >
      {isTerminal ? (
        <TerminalTabContent props={props as IDockviewPanelHeaderProps<TerminalPanelParams>} />
      ) : (
        <span className="min-w-0 truncate">{props.api.title}</span>
      )}
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className="ml-auto flex size-5 flex-none items-center justify-center rounded-badge text-fg-muted opacity-0 group-hover/tab:opacity-100 hover:bg-card-hover hover:text-fg focus-visible:opacity-100 data-[active=true]:opacity-100"
        data-active={active}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void requestClosePanel(props.containerApi, props.api.id);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}
