import { executeCommand, hasCommand } from './commands';
import type { UserKeybinding } from '@shared/domain/keybindings';
import {
  applyUserKeybindings,
  DEFAULT_KEYBINDINGS,
  type KeyContext,
  type Keybinding,
  KeybindingResolver,
  type KeyEventLike,
} from './keybindings';
import { currentPlatform } from './platform';

let resolver: KeybindingResolver | null = null;
let effective: Keybinding[] = [...DEFAULT_KEYBINDINGS];
const listeners = new Set<() => void>();

function getResolver(): KeybindingResolver {
  resolver ??= new KeybindingResolver(effective, currentPlatform(), hasCommand);
  return resolver;
}

/** Applies the entries of keybindings.json on top of the defaults. */
export function setUserKeybindings(entries: readonly UserKeybinding[]): void {
  effective = applyUserKeybindings(DEFAULT_KEYBINDINGS, entries, currentPlatform());
  resolver = null;
  for (const l of listeners) l();
}

/** The bindings in effect (defaults + user overrides, later entries win). */
export function effectiveKeybindings(): readonly Keybinding[] {
  return effective;
}

/** Subscribes to keybinding changes (useSyncExternalStore-compatible). */
export function onDidChangeKeybindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tries to run a keybinding for the event; returns true when a command handled it. */
export function dispatchKeybinding(e: KeyEventLike, context: KeyContext): boolean {
  const binding = getResolver().resolve(e, context);
  if (!binding) return false;
  void executeCommand(binding.command, ...(binding.args ?? []));
  return true;
}

/** Chords the shell handles in plugin views (sent to the SDK in `oxy:init`). */
export function reservedChords(): string[] {
  return getResolver().chords('pluginViewFocus');
}

export function shortcutFor(command: string): string | undefined {
  return getResolver().shortcutFor(command);
}

function contextOf(target: EventTarget | null): KeyContext | 'terminal' | 'none' {
  const el = target instanceof Element ? target : null;
  // Shortcut recorder: every chord is captured, none is dispatched.
  if (el?.closest('[data-no-keybindings]')) return 'none';
  if (el?.closest('.xterm')) return 'terminal';
  // Monaco's hidden textarea lives inside the diff panel: treat it as the diff, not as a text input.
  if (el?.closest('[data-keycontext="diff"] .monaco-editor')) return 'diffFocus';
  if (el?.closest('[data-keycontext="code"] .monaco-editor')) return 'editorFocus';
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable))
    return 'inputFocus';
  if (el?.closest('[data-keycontext="changes"]')) return 'changesFocus';
  if (el?.closest('[data-keycontext="diff"]')) return 'diffFocus';
  if (el?.closest('[data-keycontext="sidebar"]')) return 'sidebarFocus';
  return 'global';
}

let installed = false;
/** Global keydown listener for everything outside terminals (terminals use attachCustomKeyEventHandler). */
export function installGlobalKeybindings(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      const context = contextOf(e.target);
      if (context === 'terminal' || context === 'none') return;
      if (dispatchKeybinding(e, context)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
