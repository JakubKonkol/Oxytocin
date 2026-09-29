import { DropdownMenu, Popover } from 'radix-ui';
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  Heading,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Send,
  Settings2,
  SquareCode,
  Strikethrough,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import type { CoreSettings } from '@shared/domain/settings';
import {
  otherScratchpadsWithText,
  scratchpadText,
  withScratchpadShared,
  withScratchpadText,
} from '@shared/domain/ui-state';
import { cn } from '../../lib/cn';
import { ipc } from '../../lib/ipc-client';
import { confirmDialog } from '../../stores/dialog-store';
import { useProjectsStore } from '../../stores/projects-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { useUiStore } from '../../stores/ui-store';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { openSettingsEditor } from '../settings/SettingsPanel';
import {
  codeBlock,
  continueList,
  type InlineFormat,
  type LineFormat,
  type TextChange,
  toggleInline,
  toggleLinePrefix,
} from './format';
import { chooseAgentTarget, currentAgentTarget, sendToAgent } from './scratchpad-actions';
import { type AgentTarget, agentTargets } from './send-target';

const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-badge px-2 text-ui text-fg outline-none data-[highlighted]:bg-accent-muted';

type ScratchpadSettings = {
  fontFamily: CoreSettings['scratchpad.fontFamily'];
  fontSize: number;
  lineHeight: number;
  wordWrap: boolean;
  formattingToolbar: boolean;
  continueLists: boolean;
  spellCheck: boolean;
};

const FONT_FAMILIES: Record<ScratchpadSettings['fontFamily'], string> = {
  mono: 'var(--font-mono)',
  sans: 'var(--font-ui)',
  serif: 'var(--font-serif)',
};

/** `scratchpad.*` settings (defaults until settings are loaded). */
function useScratchpadSettings(): ScratchpadSettings {
  const s = useSettingsStore((st) => st.settings);
  return {
    fontFamily: s?.['scratchpad.fontFamily'] ?? 'mono',
    fontSize: s?.['scratchpad.fontSize'] ?? 12,
    lineHeight: s?.['scratchpad.lineHeight'] ?? 1.5,
    wordWrap: s?.['scratchpad.wordWrap'] ?? true,
    formattingToolbar: s?.['scratchpad.formattingToolbar'] ?? true,
    continueLists: s?.['scratchpad.continueLists'] ?? true,
    spellCheck: s?.['scratchpad.spellCheck'] ?? false,
  };
}

const updateSetting = (key: `scratchpad.${string}`, value: unknown) =>
  void ipc.invoke('settings:update', { [key]: value });

const knownProjectIds = () => {
  const { projects } = useProjectsStore.getState();
  // Not loaded yet: prune nothing.
  return projects.length > 0 ? projects.map((p) => p.id) : undefined;
};

/** Sets the text the scratchpad shows now (the shared one, or the active project's own). */
function setScratchpadText(text: string): void {
  const ui = useUiStore.getState();
  const activeId = useProjectsStore.getState().activeId;
  ui.setScratchpad(withScratchpadText(ui.state.scratchpad, activeId, text, knownProjectIds()));
}

/** The text the scratchpad shows now. */
function useScratchpadText(): string {
  const activeId = useProjectsStore((s) => s.activeId);
  return useUiStore((s) => scratchpadText(s.state.scratchpad, activeId));
}

/**
 * Turns "Share across projects" on or off. Turning it on replaces the other projects' own scratchpads with this
 * one, so that asks first when any of them has text.
 */
async function setScratchpadShared(shared: boolean): Promise<void> {
  const activeId = useProjectsStore.getState().activeId;
  const current = useUiStore.getState().state.scratchpad;
  if (shared) {
    const others = otherScratchpadsWithText(current, activeId, knownProjectIds());
    if (others.length > 0) {
      const names = others
        .map((id) => useProjectsStore.getState().projects.find((p) => p.id === id)?.name)
        .filter((n): n is string => !!n);
      const which =
        names.length > 0 && names.length <= 3
          ? names.join(', ')
          : `${others.length} other project${others.length === 1 ? '' : 's'}`;
      const ok = await confirmDialog({
        title: 'Share one scratchpad across projects?',
        description: `The scratchpad of ${which} will be replaced by the one you see now. Its text cannot be restored.`,
        confirmLabel: 'Share and replace',
        destructive: true,
      });
      if (!ok) return;
    }
  }
  const latest = useUiStore.getState();
  latest.setScratchpad(withScratchpadShared(latest.state.scratchpad, shared, useProjectsStore.getState().activeId));
}

/** "Share across projects": one scratchpad for all projects, or one per project. */
export function ScratchpadShareToggle() {
  const shared = useUiStore((s) => s.state.scratchpad.shared);
  return (
    <Tooltip label={shared ? 'Every project shows the same scratchpad' : 'Every project has its own scratchpad'}>
      <label className="flex h-6 cursor-pointer items-center gap-1.5 rounded-control px-1 text-small whitespace-nowrap text-fg-secondary hover:bg-card-hover hover:text-fg">
        <input
          type="checkbox"
          data-testid="scratchpad-shared"
          checked={shared}
          onChange={(e) => void setScratchpadShared(e.target.checked)}
          className="accent-accent"
        />
        Share across projects
      </label>
    </Tooltip>
  );
}

/** Running agents, recomputed when terminals or projects change. */
function useAgentTargets(): AgentTarget[] {
  const terminals = useTerminalsStore((s) => s.terminals);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  return agentTargets(terminals, projects, activeId);
}

function Toggle({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 px-1 text-ui text-fg">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

/** Font, size and editing options of the scratchpad (the same `scratchpad.*` settings as in Settings). */
export function ScratchpadSettingsButton() {
  const s = useScratchpadSettings();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton data-testid="scratchpad-settings" label="Scratchpad settings" icon={<Settings2 size={13} />} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          data-testid="scratchpad-settings-popover"
          className="z-50 w-64 rounded-control border border-line bg-elevated p-2 shadow-lg"
        >
          <div className="oxy-label px-1 pb-1">Font</div>
          <div className="flex gap-1 px-1" role="radiogroup" aria-label="Font">
            {(['mono', 'sans', 'serif'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={s.fontFamily === f}
                data-testid={`scratchpad-font-${f}`}
                onClick={() => updateSetting('scratchpad.fontFamily', f)}
                style={{ fontFamily: FONT_FAMILIES[f] }}
                className={cn(
                  'h-7 flex-1 rounded-control border text-ui',
                  s.fontFamily === f ? 'border-accent bg-accent-muted text-fg' : 'border-line text-fg-secondary',
                )}
              >
                {f === 'mono' ? 'Mono' : f === 'sans' ? 'Sans' : 'Serif'}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1 px-1">
            <span className="flex-1 text-ui text-fg">Size</span>
            <IconButton
              label="Smaller"
              data-testid="scratchpad-font-smaller"
              icon={<Minus size={12} />}
              disabled={s.fontSize <= 9}
              onClick={() => updateSetting('scratchpad.fontSize', s.fontSize - 1)}
            />
            <span className="w-10 text-center font-mono text-small text-fg" data-testid="scratchpad-font-size">
              {s.fontSize}px
            </span>
            <IconButton
              label="Larger"
              data-testid="scratchpad-font-larger"
              icon={<Plus size={12} />}
              disabled={s.fontSize >= 28}
              onClick={() => updateSetting('scratchpad.fontSize', s.fontSize + 1)}
            />
          </div>
          <div className="mt-1 flex items-center gap-1 px-1">
            <span className="flex-1 text-ui text-fg">Line height</span>
            <select
              aria-label="Line height"
              value={String(s.lineHeight)}
              onChange={(e) => updateSetting('scratchpad.lineHeight', Number(e.target.value))}
              className="h-6 rounded-control border border-line bg-input px-1 text-small text-fg"
            >
              {[1.2, 1.35, 1.5, 1.75, 2].map((v) => (
                <option key={v} value={String(v)}>
                  {v}
                </option>
              ))}
              {![1.2, 1.35, 1.5, 1.75, 2].includes(s.lineHeight) && (
                <option value={String(s.lineHeight)}>{s.lineHeight}</option>
              )}
            </select>
          </div>
          <div className="mt-2 border-t border-line-subtle pt-1">
            <Toggle
              label="Wrap long lines"
              testId="scratchpad-wrap"
              checked={s.wordWrap}
              onChange={(v) => updateSetting('scratchpad.wordWrap', v)}
            />
            <Toggle
              label="Formatting toolbar"
              testId="scratchpad-toolbar-toggle"
              checked={s.formattingToolbar}
              onChange={(v) => updateSetting('scratchpad.formattingToolbar', v)}
            />
            <Toggle
              label="Continue lists on Enter"
              testId="scratchpad-continue-lists"
              checked={s.continueLists}
              onChange={(v) => updateSetting('scratchpad.continueLists', v)}
            />
            <Toggle
              label="Check spelling"
              testId="scratchpad-spellcheck"
              checked={s.spellCheck}
              onChange={(v) => updateSetting('scratchpad.spellCheck', v)}
            />
          </div>
          <button
            type="button"
            className="mt-1 w-full rounded-control px-1 py-1 text-left text-small text-accent hover:bg-card-hover"
            onClick={() => openSettingsEditor('scratchpad.')}
          >
            All scratchpad settings…
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ScratchpadClearButton() {
  const empty = useScratchpadText().length === 0;
  return (
    <IconButton
      label="Clear scratchpad"
      icon={<Trash2 size={13} />}
      disabled={empty}
      onClick={() => setScratchpadText('')}
    />
  );
}

/** Actions in the scratchpad's section header (right sidebar). */
export function ScratchpadHeaderActions() {
  return (
    <>
      <ScratchpadSettingsButton />
      <ScratchpadClearButton />
    </>
  );
}

type FormatAction =
  { kind: 'inline'; format: InlineFormat } | { kind: 'line'; format: LineFormat } | { kind: 'codeBlock' };

const TOOLBAR: { id: string; label: string; shortcut?: string; icon: ReactNode; action: FormatAction }[][] = [
  [
    {
      id: 'bold',
      label: 'Bold',
      shortcut: 'Mod+B',
      icon: <Bold size={13} />,
      action: { kind: 'inline', format: 'bold' },
    },
    {
      id: 'italic',
      label: 'Italic',
      shortcut: 'Mod+I',
      icon: <Italic size={13} />,
      action: { kind: 'inline', format: 'italic' },
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      icon: <Strikethrough size={13} />,
      action: { kind: 'inline', format: 'strike' },
    },
    {
      id: 'code',
      label: 'Inline code',
      shortcut: 'Mod+E',
      icon: <Code size={13} />,
      action: { kind: 'inline', format: 'code' },
    },
    { id: 'codeBlock', label: 'Code block', icon: <SquareCode size={13} />, action: { kind: 'codeBlock' } },
  ],
  [
    { id: 'heading', label: 'Heading', icon: <Heading size={13} />, action: { kind: 'line', format: 'heading' } },
    { id: 'bullet', label: 'Bulleted list', icon: <List size={13} />, action: { kind: 'line', format: 'bullet' } },
    {
      id: 'numbered',
      label: 'Numbered list',
      icon: <ListOrdered size={13} />,
      action: { kind: 'line', format: 'numbered' },
    },
    { id: 'task', label: 'Checklist', icon: <ListChecks size={13} />, action: { kind: 'line', format: 'task' } },
    { id: 'quote', label: 'Quote', icon: <Quote size={13} />, action: { kind: 'line', format: 'quote' } },
  ],
];

function changeFor(action: FormatAction, text: string, start: number, end: number): TextChange {
  if (action.kind === 'inline') return toggleInline(text, start, end, action.format);
  if (action.kind === 'line') return toggleLinePrefix(text, start, end, action.format);
  return codeBlock(text, start, end);
}

/**
 * Applies a change through `insertText` so the browser's undo (Ctrl+Z) keeps working; the textarea's input event
 * updates the store. Falls back to setting the text directly.
 */
function applyToTextarea(el: HTMLTextAreaElement, change: TextChange, setText: (text: string) => void): void {
  el.focus();
  el.setSelectionRange(change.from, change.to);
  const done =
    change.insert.length > 0
      ? document.execCommand('insertText', false, change.insert)
      : change.from === change.to || document.execCommand('delete');
  if (!done) {
    setText(el.value.slice(0, change.from) + change.insert + el.value.slice(change.to));
    requestAnimationFrame(() => el.setSelectionRange(change.selStart, change.selEnd));
    return;
  }
  el.setSelectionRange(change.selStart, change.selEnd);
}

/**
 * Notes and prompt drafts (persisted in ui-state.json) with Markdown formatting and "Send to agent". Rendered in
 * the right sidebar and as a workspace panel; every instance edits the same text.
 */
export function ScratchpadEditor({ actions }: { actions?: ReactNode }) {
  const text = useScratchpadText();
  const setText = setScratchpadText;
  const settings = useScratchpadSettings();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const targets = useAgentTargets();
  // Re-render after choosing a target in the menu (the choice lives outside React).
  const [, setChoice] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const target = currentAgentTarget(targets);
  const canSend = text.trim().length > 0 && targets.length > 0;

  const send = (to: AgentTarget | null = target) => {
    if (!canSend) return;
    if (!to) {
      setMenuOpen(true);
      return;
    }
    void sendToAgent(to, text);
  };

  const format = (action: FormatAction) => {
    const el = textareaRef.current;
    if (!el) return;
    applyToTextarea(el, changeFor(action, el.value, el.selectionStart, el.selectionEnd), setText);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      send();
      return;
    }
    const el = e.currentTarget;
    if (mod && !e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      const inline: InlineFormat | undefined =
        key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'e' ? 'code' : undefined;
      if (inline) {
        e.preventDefault();
        format({ kind: 'inline', format: inline });
        return;
      }
    }
    if (
      e.key === 'Enter' &&
      !mod &&
      !e.shiftKey &&
      !e.altKey &&
      settings.continueLists &&
      el.selectionStart === el.selectionEnd
    ) {
      const change = continueList(el.value, el.selectionStart);
      if (change) {
        e.preventDefault();
        applyToTextarea(el, change, setText);
      }
    }
  };

  const hint =
    targets.length === 0
      ? 'No agent is running'
      : target
        ? `Paste into ${target.label}`
        : 'Choose the agent to paste into';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="mb-1.5 flex flex-none flex-wrap items-center gap-0.5"
        data-testid="scratchpad-toolbar"
        role="toolbar"
        aria-label="Formatting"
      >
        {settings.formattingToolbar &&
          TOOLBAR.map((group, i) => (
            <div key={i} className={cn('flex items-center gap-0.5', i > 0 && 'border-l border-line-subtle pl-0.5')}>
              {group.map((b) => (
                <IconButton
                  key={b.id}
                  data-testid={`scratchpad-format-${b.id}`}
                  label={b.label}
                  {...(b.shortcut ? { shortcut: b.shortcut } : {})}
                  icon={b.icon}
                  // Keep the textarea's selection.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => format(b.action)}
                />
              ))}
            </div>
          ))}
        <div className="ml-auto flex items-center gap-0.5">
          <ScratchpadShareToggle />
          {actions}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        data-testid="scratchpad-input"
        aria-label="Scratchpad"
        placeholder="Notes and prompt drafts…"
        spellCheck={settings.spellCheck}
        wrap={settings.wordWrap ? 'soft' : 'off'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        style={{
          fontFamily: FONT_FAMILIES[settings.fontFamily],
          fontSize: `${settings.fontSize}px`,
          lineHeight: settings.lineHeight,
        }}
        className={cn(
          'min-h-0 flex-1 resize-none rounded-control border border-line bg-input p-2 text-fg outline-none placeholder:text-fg-muted focus:border-accent',
          !settings.wordWrap && 'overflow-x-auto whitespace-pre',
        )}
      />
      <div className="mt-2 flex flex-none items-center gap-1">
        <Tooltip label={hint} shortcut="Ctrl+Enter">
          <Button
            data-testid="scratchpad-send"
            variant="primary"
            size="sm"
            className={canSend ? 'min-w-0 flex-1' : 'min-w-0 flex-1 opacity-50'}
            aria-disabled={!canSend}
            onClick={() => send()}
          >
            <Send size={12} className="flex-none" />
            <span className="truncate">{target ? `Send to ${target.label}` : 'Send to agent'}</span>
          </Button>
        </Tooltip>
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <IconButton
              data-testid="scratchpad-target"
              label="Choose agent"
              icon={<ChevronDown size={14} />}
              disabled={targets.length === 0}
            />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="z-50 max-w-80 min-w-48 rounded-control border border-line bg-elevated p-1 shadow-lg"
            >
              <DropdownMenu.Label className="px-2 py-1 text-small text-fg-muted">Send to</DropdownMenu.Label>
              {targets.map((t) => (
                <DropdownMenu.Item
                  key={t.terminalId}
                  data-testid={`scratchpad-target-${t.terminalId}`}
                  className={menuItem}
                  onSelect={() => {
                    chooseAgentTarget(t.terminalId);
                    setChoice((n) => n + 1);
                    send(t);
                  }}
                >
                  <Check
                    size={12}
                    className={t.terminalId === target?.terminalId ? 'flex-none' : 'invisible flex-none'}
                  />
                  <span className="truncate">{t.label}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}

/** The scratchpad as a right-sidebar section (actions live in the section header). */
export function ScratchpadSection() {
  return (
    <div className="flex h-full flex-col rounded-b-card border border-t-0 border-line-subtle bg-card px-2 pb-2">
      <ScratchpadEditor />
    </div>
  );
}

/** The scratchpad as a workspace panel (no section header: its actions sit in the toolbar). */
export function ScratchpadPanel() {
  return (
    <div className="flex h-full flex-col bg-card p-2" data-testid="scratchpad-panel">
      <ScratchpadEditor
        actions={
          <>
            <ScratchpadSettingsButton />
            <ScratchpadClearButton />
          </>
        }
      />
    </div>
  );
}
