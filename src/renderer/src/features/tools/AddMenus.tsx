import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';
import { DropdownMenu } from 'radix-ui';
import { Blocks, Bot, ChevronRight, NotebookPen, Plus, SquareTerminal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { TerminalProfile } from '@shared/domain/terminal-profile';
import { ipc } from '../../lib/ipc-client';
import { shortcutFor } from '../../lib/keyboard';
import { IconButton } from '../../ui/IconButton';
import { formatShortcut } from '../../ui/Kbd';
import { notify } from '../../ui/Toast';
import { addTerminalPanel } from '../layout/workspace-actions';
import {
  addSidebarTool,
  openToolInWorkspace,
  SCRATCHPAD_TOOL_ID,
  sidebarToolFor,
  type ToolDefinition,
  useAvailableTools,
} from './tools';

const menuContent = 'z-50 min-w-52 max-w-80 rounded-control border border-line bg-elevated p-1 shadow-lg';
const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';
const menuLabel = 'oxy-label px-2 pt-1.5 pb-1';

function ToolIcon({ tool }: { tool: ToolDefinition }) {
  return tool.id === SCRATCHPAD_TOOL_ID ? (
    <NotebookPen size={14} className="flex-none text-fg-muted" />
  ) : (
    <Blocks size={14} className="flex-none text-fg-muted" />
  );
}

function ToolItems({ tools, onPick }: { tools: ToolDefinition[]; onPick: (tool: ToolDefinition) => void }) {
  return (
    <>
      {tools.map((t) => (
        <DropdownMenu.Item key={t.id} data-testid={`add-tool-${t.id}`} className={menuItem} onSelect={() => onPick(t)}>
          <ToolIcon tool={t} />
          <span className="truncate">{t.title}</span>
        </DropdownMenu.Item>
      ))}
    </>
  );
}

const report = (what: string) => (e: unknown) =>
  notify('error', `Could not open ${what}`, { description: e instanceof Error ? e.message : String(e) });

/**
 * The "+" of a workspace group: a new terminal (default or another profile) or a tool (scratchpad, plugin panels
 * with `showInAddMenu`), opened in that group.
 */
export function WorkspaceAddMenu({
  api,
  group,
  projectId,
  onOpen,
}: {
  api: DockviewApi;
  group: DockviewGroupPanel;
  projectId: () => string | undefined;
  onOpen?: () => void;
}) {
  const tools = useAvailableTools();
  const [profiles, setProfiles] = useState<TerminalProfile[] | null>(null);
  const newTerminal = shortcutFor('terminal.new');
  const withProfile = shortcutFor('terminal.newWithProfile');

  const terminal = (profileId?: string) => {
    const p = projectId();
    if (p) void addTerminalPanel(api, { projectId: p, ...(profileId ? { profileId } : {}) }, { referenceGroup: group });
  };

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) return;
        onOpen?.();
        void ipc.invoke('terminals:profiles').then(setProfiles, () => setProfiles([]));
      }}
    >
      <DropdownMenu.Trigger asChild>
        <IconButton data-testid="group-add" label="New terminal or tool" icon={<Plus size={14} />} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuContent} data-testid="group-add-menu">
          <DropdownMenu.Label className={menuLabel}>Terminal</DropdownMenu.Label>
          <DropdownMenu.Item data-testid="add-terminal" className={menuItem} onSelect={() => terminal()}>
            <SquareTerminal size={14} className="flex-none text-fg-muted" />
            <span className="flex-1 truncate">New terminal</span>
            {newTerminal && <span className="font-mono text-small text-fg-muted">{formatShortcut(newTerminal)}</span>}
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger data-testid="add-terminal-profile" className={menuItem}>
              <SquareTerminal size={14} className="flex-none text-fg-muted" />
              <span className="flex-1 truncate">Terminal profile</span>
              {withProfile && <span className="font-mono text-small text-fg-muted">{formatShortcut(withProfile)}</span>}
              <ChevronRight size={12} className="flex-none text-fg-muted" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent sideOffset={4} className={menuContent}>
                {(profiles ?? []).map((p) => (
                  <DropdownMenu.Item
                    key={p.id}
                    data-testid={`add-profile-${p.id}`}
                    className={menuItem}
                    onSelect={() => terminal(p.id)}
                  >
                    {p.kind === 'agent' ? (
                      <Bot size={14} className="flex-none text-agent" />
                    ) : (
                      <SquareTerminal size={14} className="flex-none text-fg-muted" />
                    )}
                    <span className="flex-1 truncate">{p.name}</span>
                  </DropdownMenu.Item>
                ))}
                {profiles === null && <div className="px-2 py-1 text-small text-fg-muted">Detecting profiles…</div>}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator className="my-1 h-px bg-line-subtle" />
          <DropdownMenu.Label className={menuLabel}>Tools</DropdownMenu.Label>
          <ToolItems
            tools={tools}
            onPick={(t) => {
              const p = projectId();
              if (p) void openToolInWorkspace(t, { api, projectId: p, group }).catch(report(t.title));
            }}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** "Add tool" of the right sidebar: adds a tool below `index` (or at the bottom). */
export function SidebarAddToolMenu({ trigger, index }: { trigger: ReactNode; index?: number }) {
  const tools = useAvailableTools();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuContent} data-testid="sidebar-add-tool-menu">
          <DropdownMenu.Label className={menuLabel}>Add tool</DropdownMenu.Label>
          <ToolItems tools={tools} onPick={(t) => addSidebarTool(sidebarToolFor(t), index)} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
