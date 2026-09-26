import { executeCommand, hasCommand } from './commands';
import { DEFAULT_KEYBINDINGS, type KeyContext, KeybindingResolver, type KeyEventLike } from './keybindings';
import { currentPlatform } from './platform';

let resolver: KeybindingResolver | null = null;

function getResolver(): KeybindingResolver {
  resolver ??= new KeybindingResolver(DEFAULT_KEYBINDINGS, currentPlatform(), hasCommand);
  return resolver;
}

/** Tries to run a keybinding for the event; returns true when a command handled it. */
export function dispatchKeybinding(e: KeyEventLike, context: KeyContext): boolean {
  const binding = getResolver().resolve(e, context);
  if (!binding) return false;
  void executeCommand(binding.command, ...(binding.args ?? []));
  return true;
}

export function shortcutFor(command: string): string | undefined {
  return getResolver().shortcutFor(command);
}

function contextOf(target: EventTarget | null): KeyContext | 'terminal' {
  const el = target instanceof Element ? target : null;
  if (el?.closest('.xterm')) return 'terminal';
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
      if (context === 'terminal') return;
      if (dispatchKeybinding(e, context)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
