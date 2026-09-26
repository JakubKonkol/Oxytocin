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
import { useRenameStore } from './rename-store';
import { ipc } from '../../lib/ipc-client';

function useIsActive(props: IDockviewPanelHeaderProps): boolean {
  const [active, setActive] = useState(props.api.isActive);
  useEffect(() => {
    const d = props.api.onDidActiveChange((e) => setActive(e.isActive));
    return () => d.dispose();
  }, [props.api]);
  return active;
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      // Rename starts on an explicit double-click, so taking focus is expected.
      autoFocus
      aria-label="Terminal name"
      data-testid="tab-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(value);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(value)}
      onFocus={(e) => e.currentTarget.select()}
      className="h-5 min-w-0 flex-1 rounded-badge border border-line-focus bg-input px-1 text-ui text-fg outline-none"
    />
  );
}

function TerminalTabContent({ props }: { props: IDockviewPanelHeaderProps<TerminalPanelParams> }) {
  const info = useTerminalsStore((s) => s.terminals[props.params.terminalId]);
  const renaming = useRenameStore((s) => s.panelId === props.api.id);
  const title = info?.title ?? props.api.title ?? 'Terminal';
  useEffect(() => {
    if (props.api.title !== title) props.api.setTitle(title);
  }, [props.api, title]);
  return (
    <>
      {info && (
        <StatusDot state={terminalDotState(info)} title={terminalDotLabel(info)} size={7} testId="tab-status-dot" />
      )}
      {renaming ? (
        <RenameInput
          initial={info?.userTitle ?? title}
          onDone={(value) => {
            useRenameStore.getState().stop();
            if (value !== null) void ipc.invoke('terminals:rename', { id: props.params.terminalId, title: value });
          }}
        />
      ) : (
        <span
          data-testid="tab-title"
          className="min-w-0 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            useRenameStore.getState().start(props.api.id);
          }}
        >
          {title}
        </span>
      )}
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
