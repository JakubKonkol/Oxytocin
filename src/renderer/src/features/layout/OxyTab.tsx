import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { FileCode2, GitCompare, ListChecks, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { cn } from '../../lib/cn';
import { useTerminalsStore } from '../../stores/terminals-store';
import { StatusDot } from '../../ui/StatusDot';
import { BellIndicator, TerminalKindBadge } from '../terminals/TerminalBadges';
import { terminalDotLabel, terminalDotState } from '../terminals/terminal-status';
import type { TerminalPanelParams } from './panel-registry';
import { requestClosePanel, restartTerminalPanel } from './workspace-actions';
import { useRenameStore } from './rename-store';
import { ipc } from '../../lib/ipc-client';
import { useChangesStore } from '../../stores/changes-store';
import { type DiffPanelParams, pinDiff } from '../diff/diff-actions';
import { type CodePanelParams, pinCodePanel } from '../editor/editor-actions';
import { STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { usePluginViewMeta } from '../plugins/view-meta-store';
import { Badge } from '../../ui/Badge';

function useIsActive(props: IDockviewPanelHeaderProps): boolean {
  const [active, setActive] = useState(props.api.isActive);
  useEffect(() => {
    const d = props.api.onDidActiveChange((e) => setActive(e.isActive));
    return () => d.dispose();
  }, [props.api]);
  return active;
}

/** Panel title that follows `api.setTitle` (dockview does not re-render custom tabs on title changes). */
function usePanelTitle(props: IDockviewPanelHeaderProps): string | undefined {
  const { api } = props;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const d = api.onDidTitleChange(onChange);
      return () => d.dispose();
    },
    [api],
  );
  return useSyncExternalStore(subscribe, () => api.title);
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
      {info?.envStale && info.state === 'running' && (
        <button
          type="button"
          data-testid="tab-env-stale"
          aria-label="Environment out of date — restart the terminal to apply plugin changes"
          title="Environment out of date — restart the terminal to apply plugin changes"
          className="flex size-4 flex-none items-center justify-center rounded-badge text-warning hover:bg-card-hover"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void restartTerminalPanel(props.containerApi, props.api.id);
          }}
        >
          <RotateCw size={11} />
        </button>
      )}
    </>
  );
}

function DiffTabContent({ props }: { props: IDockviewPanelHeaderProps<DiffPanelParams> }) {
  const { projectId, path, preview } = props.params;
  const status = useChangesStore((s) => s.status[projectId]?.files.find((f) => f.path === path)?.status);
  return (
    <>
      <GitCompare size={12} aria-hidden className="flex-none text-fg-muted" />
      <span
        data-testid="tab-title"
        data-preview={preview}
        title={preview ? `${path} — diff (preview, double-click to keep open)` : `${path} — diff`}
        className={cn('min-w-0 truncate', preview && 'italic')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          pinDiff(props.containerApi, props.api.id);
        }}
      >
        {props.api.title ?? path}
      </span>
      {status && (
        <span className={cn('flex-none font-mono text-small font-semibold', STATUS_TEXT_CLASS[status])}>
          {STATUS_LETTERS[status]}
        </span>
      )}
    </>
  );
}

/** Code editor tab: preview tabs in italics (double-click keeps them), unsaved edits (●) and the git status. */
function CodeTabContent({ props }: { props: IDockviewPanelHeaderProps<CodePanelParams> }) {
  const { projectId, path, preview } = props.params;
  const status = useChangesStore((s) => s.status[projectId]?.files.find((f) => f.path === path)?.status);
  const title = usePanelTitle(props);
  return (
    <>
      <FileCode2 size={12} aria-hidden className="flex-none text-fg-muted" />
      <span
        data-testid="tab-title"
        data-preview={preview}
        title={preview ? `${path} (preview — double-click to keep open)` : path}
        className={cn('min-w-0 truncate', preview && 'italic')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          pinCodePanel(props.containerApi, props.api.id);
        }}
      >
        {title}
      </span>
      {status && (
        <span className={cn('flex-none font-mono text-small font-semibold', STATUS_TEXT_CLASS[status])}>
          {STATUS_LETTERS[status]}
        </span>
      )}
    </>
  );
}

/** Plugin panel: title set by the view/backend and its badge (e.g. "changed"). */
function PluginTabContent({ props }: { props: IDockviewPanelHeaderProps }) {
  const badge = usePluginViewMeta((s) => s.meta[props.api.id]?.badge);
  const title = usePanelTitle(props);
  return (
    <>
      <span className="min-w-0 truncate">{title}</span>
      {badge && (
        <Badge variant={badge.tone ?? 'neutral'} testId="tab-plugin-badge">
          {badge.text}
        </Badge>
      )}
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
      ) : props.api.component === 'diff' ? (
        <DiffTabContent props={props as IDockviewPanelHeaderProps<DiffPanelParams>} />
      ) : props.api.component === 'code' ? (
        <CodeTabContent props={props as IDockviewPanelHeaderProps<CodePanelParams>} />
      ) : props.api.component === 'plugin' ? (
        <PluginTabContent props={props} />
      ) : props.api.component === 'review' ? (
        <>
          <ListChecks size={12} aria-hidden className="flex-none text-fg-muted" />
          <span className="min-w-0 truncate">{props.api.title}</span>
        </>
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
