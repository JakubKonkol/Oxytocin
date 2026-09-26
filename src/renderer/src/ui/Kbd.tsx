import { currentPlatform, type UiPlatform } from '../lib/platform';

const MAC_SYMBOLS: Record<string, string> = {
  ctrl: '⌃',
  cmd: '⌘',
  meta: '⌘',
  mod: '⌘',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '↩',
  backspace: '⌫',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

const PC_NAMES: Record<string, string> = { mod: 'Ctrl', cmd: 'Ctrl', meta: 'Win', option: 'Alt' };

/** Formats a shortcut such as "Mod+Shift+B" for the platform: Ctrl+Shift+B / ⌘⇧B. */
export function formatShortcut(shortcut: string, platform: UiPlatform = currentPlatform()): string {
  const parts = shortcut.split('+').map((p) => p.trim());
  if (platform === 'darwin') {
    return parts.map((p) => MAC_SYMBOLS[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p)).join('');
  }
  return parts
    .map((p) => PC_NAMES[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))
    .join('+');
}

export function Kbd({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <kbd
      className={`rounded-badge border border-line bg-input px-1 font-mono text-small text-fg-secondary ${className ?? ''}`}
    >
      {formatShortcut(shortcut)}
    </kbd>
  );
}
