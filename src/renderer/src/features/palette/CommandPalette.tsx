import { Command } from 'cmdk';
import { Bot, ChevronRight, File as FileIcon, SquareTerminal } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { executeCommand, paletteCommands } from '../../lib/commands';
import { ipc } from '../../lib/ipc-client';
import { shortcutFor } from '../../lib/keyboard';
import { useChangesStore } from '../../stores/changes-store';
import { useProjectsStore } from '../../stores/projects-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { useUiStore } from '../../stores/ui-store';
import { Kbd } from '../../ui/Kbd';
import { notify } from '../../ui/Toast';
import { revealTerminal } from '../attention/reveal';
import { STATUS_LABELS, STATUS_LETTERS, STATUS_TEXT_CLASS } from '../changes/tree-model';
import { openDiff } from '../diff/diff-actions';
import { showFile } from '../editor/editor-actions';
import { activateProject } from '../projects/project-actions';
import { ProjectAvatar } from '../projects/ProjectAvatar';
import { highlightRuns } from './fuzzy';
import { resolvePick, usePaletteStore } from './palette-store';
import {
  buildItems,
  type PaletteAction,
  type PaletteItem,
  type PaletteMode,
  parseQuery,
  pickItems,
  type RankedItem,
  rankItems,
  splitTitle,
} from './quick-open-model';

const PLACEHOLDERS: Record<PaletteMode, string> = {
  all: 'Search projects, terminals and files (> commands, @ terminals, # changed files, % files)',
  commands: 'Type the name of a command',
  terminals: 'Go to a terminal',
  files: 'Go to a changed file of the active project',
  projectFiles: 'Go to a file of the active project',
};

const EMPTY: Record<PaletteMode, string> = {
  all: 'No matching projects, terminals or files',
  commands: 'No matching commands',
  terminals: 'No matching terminals',
  files: 'No matching changed files',
  projectFiles: 'No matching files',
};

/** Files of a project for Quick Open, read when it opens (kept for 30 s). */
const fileCache = new Map<string, { at: number; files: string[] }>();

function useProjectFiles(projectId: string | null, enabled: boolean): string[] | undefined {
  const cached = projectId ? fileCache.get(projectId) : undefined;
  const [files, setFiles] = useState<string[] | undefined>(cached?.files);
  useEffect(() => {
    if (!projectId || !enabled) return;
    if (cached && Date.now() - cached.at < 30_000) return;
    let alive = true;
    void ipc.invoke('files:find', { projectId }).then(
      (r) => {
        fileCache.set(projectId, { at: Date.now(), files: r.files });
        if (alive) setFiles(r.files);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [projectId, enabled, cached]);
  return files;
}

const PICK_LIMIT = 500;

function runAction(action: PaletteAction): void {
  switch (action.kind) {
    case 'command':
      useUiStore.getState().recordCommand(action.id);
      void Promise.resolve()
        .then(() => executeCommand(action.id))
        .catch((e: unknown) =>
          notify('error', 'The command failed', { description: e instanceof Error ? e.message : String(e) }),
        );
      return;
    case 'project':
      activateProject(action.projectId);
      return;
    case 'terminal':
      void revealTerminal(action.projectId, action.terminalId);
      return;
    case 'file':
      activateProject(action.projectId);
      openDiff(action.projectId, { path: action.path, ...(action.oldPath ? { oldPath: action.oldPath } : {}) });
      return;
    case 'openFile':
      void showFile(action.projectId, action.path);
      return;
    case 'pick':
      resolvePick(action.index);
      return;
  }
}

function Highlighted({ item }: { item: RankedItem }) {
  if (item.icon.kind === 'command') {
    // "Category: Title" → muted category, highlights keep their positions.
    const { category } = splitTitle(item.label);
    const cut = category ? category.length + 2 : 0;
    return (
      <>
        {category && (
          <span className="text-fg-muted">
            <Runs text={item.label.slice(0, cut)} indices={item.indices} offset={0} />
          </span>
        )}
        <Runs text={item.label.slice(cut)} indices={item.indices} offset={cut} />
      </>
    );
  }
  return <Runs text={item.label} indices={item.indices} offset={item.labelOffset} />;
}

function Runs({ text, indices, offset }: { text: string; indices: number[]; offset: number }) {
  return (
    <>
      {highlightRuns(text, indices, offset).map((r, i) =>
        r.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

function ItemIcon({ item }: { item: PaletteItem }) {
  switch (item.icon.kind) {
    case 'command':
      return <ChevronRight size={14} className="flex-none text-fg-muted" />;
    case 'project':
      return <ProjectAvatar project={item.icon.project} size={16} />;
    case 'terminal':
      return item.icon.agent ? (
        <Bot size={14} className="flex-none text-agent" />
      ) : (
        <SquareTerminal size={14} className="flex-none text-fg-muted" />
      );
    case 'file':
      return (
        <span
          aria-label={STATUS_LABELS[item.icon.status]}
          className={cn(
            'w-3.5 flex-none text-center font-mono text-small font-semibold',
            STATUS_TEXT_CLASS[item.icon.status],
          )}
        >
          {STATUS_LETTERS[item.icon.status]}
        </span>
      );
    case 'document':
      return <FileIcon size={14} className="flex-none text-fg-muted" />;
    case 'none':
      return null;
  }
}

/**
 * Command palette and Quick Open: one dialog, the input prefix picks the source —
 * none = projects + terminals + changed files, `>` commands, `@` terminals, `#` changed files. Plugin quick
 * picks (`oxy.ui.showQuickPick`) reuse the same dialog.
 */
export function CommandPalette() {
  const isOpen = usePaletteStore((s) => s.isOpen);
  const openCount = usePaletteStore((s) => s.openCount);
  if (!isOpen) return null;
  return <PaletteDialog key={openCount} />;
}

function PaletteDialog() {
  const initial = usePaletteStore((s) => s.initial);
  const pick = usePaletteStore((s) => s.pick);
  const close = usePaletteStore((s) => s.close);
  const [input, setInput] = useState(initial);
  const [value, setValue] = useState('');

  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeId);
  const terminals = useTerminalsStore((s) => s.terminals);
  const status = useChangesStore((s) => (activeProjectId ? s.status[activeProjectId] : undefined));
  const recentCommands = useUiStore((s) => s.state.recentCommands);

  const { mode, text } = pick ? { mode: 'all' as const, text: input.trim() } : parseQuery(input);
  const projectFiles = useProjectFiles(activeProjectId, !pick && (mode === 'all' || mode === 'projectFiles'));
  // Commands are read once per mode switch: their `when` conditions reflect the state before the palette opened.
  const commands = useMemo(
    () => (mode === 'commands' ? paletteCommands().map((c) => ({ id: c.id, title: c.title })) : []),
    [mode],
  );
  const items = useMemo(() => {
    if (pick) return pickItems(pick.items);
    return buildItems(mode, {
      commands,
      recentCommands,
      projects,
      activeProjectId,
      terminals: Object.values(terminals),
      changes: status?.state === 'ok' ? status.files : [],
      ...(projectFiles ? { projectFiles } : {}),
      shortcutFor,
    });
  }, [pick, mode, commands, recentCommands, projects, activeProjectId, terminals, status, projectFiles]);
  const ranked = useMemo(() => rankItems(items, text, pick ? PICK_LIMIT : undefined), [items, text, pick]);

  // Typing resets the selection to the first result; a selection that disappeared falls back to it too.
  const selected = ranked.some((i) => i.id === value) ? value : (ranked[0]?.id ?? '');

  const groups: { heading: string; items: RankedItem[] }[] = [];
  for (const item of ranked) {
    const last = groups.at(-1);
    if (last && last.heading === item.group) last.items.push(item);
    else groups.push({ heading: item.group, items: [item] });
  }

  const choose = (item: PaletteItem) => {
    if (item.action.kind === 'pick') {
      runAction(item.action);
      return;
    }
    // Run after the dialog has closed and returned focus, so commands act on the focused panel.
    const action = item.action;
    close();
    setTimeout(() => runAction(action), 0);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-app/40" />
        <Dialog.Content
          data-testid="command-palette"
          data-mode={pick ? 'pick' : mode}
          aria-describedby={undefined}
          className="fixed top-16 left-1/2 z-50 w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-card border border-line bg-elevated shadow-elevated"
        >
          <Dialog.Title className="sr-only">{pick ? (pick.source ?? 'Quick pick') : 'Command palette'}</Dialog.Title>
          <Command label="Command palette" shouldFilter={false} value={selected} onValueChange={setValue} loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              {pick?.source && (
                <span
                  data-testid="command-palette-source"
                  className="flex-none rounded-badge bg-input px-1.5 py-0.5 text-small text-fg-muted"
                >
                  {pick.source}
                </span>
              )}
              <Command.Input
                data-testid="command-palette-input"
                autoFocus
                value={input}
                onValueChange={(v) => {
                  setInput(v);
                  setValue('');
                }}
                placeholder={pick?.placeholder ?? PLACEHOLDERS[mode]}
                className="h-10 min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-muted"
              />
            </div>
            <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1">
              <Command.Empty className="px-3 py-3 text-ui text-fg-muted">
                {pick ? 'No matching items' : EMPTY[mode]}
              </Command.Empty>
              {groups.map((g) => (
                <Command.Group
                  key={g.heading || 'items'}
                  heading={g.heading || undefined}
                  className="oxy-palette-group"
                >
                  {g.items.map((item) => (
                    <Command.Item
                      key={item.id}
                      value={item.id}
                      data-testid="command-palette-item"
                      data-item-id={item.id}
                      onSelect={() => choose(item)}
                      className="flex min-h-8 cursor-default items-center gap-2 rounded-badge px-2 py-1 text-ui text-fg data-[selected=true]:bg-accent-muted"
                    >
                      <ItemIcon item={item} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate">
                            <Highlighted item={item} />
                          </span>
                          {item.detail && <span className="truncate text-small text-fg-muted">{item.detail}</span>}
                        </span>
                        {item.subline && <span className="truncate text-small text-fg-muted">{item.subline}</span>}
                      </span>
                      {item.shortcut && <Kbd shortcut={item.shortcut} className="flex-none" />}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
