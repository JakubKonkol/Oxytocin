import type { ITheme } from '@xterm/xterm';

function cssVar(style: CSSStyleDeclaration, name: string): string {
  return style.getPropertyValue(name).trim();
}

/** xterm theme built from the CSS tokens (tokens.css is the single source of colors). */
export function buildXtermTheme(root: Element = document.documentElement): ITheme {
  const s = getComputedStyle(root);
  const v = (name: string) => cssVar(s, name);
  return {
    background: v('--bg-terminal'),
    foreground: v('--terminal-foreground'),
    cursor: v('--terminal-cursor'),
    cursorAccent: v('--bg-terminal'),
    selectionBackground: v('--terminal-selection'),
    black: v('--ansi-black'),
    red: v('--ansi-red'),
    green: v('--ansi-green'),
    yellow: v('--ansi-yellow'),
    blue: v('--ansi-blue'),
    magenta: v('--ansi-magenta'),
    cyan: v('--ansi-cyan'),
    white: v('--ansi-white'),
    brightBlack: v('--ansi-bright-black'),
    brightRed: v('--ansi-bright-red'),
    brightGreen: v('--ansi-bright-green'),
    brightYellow: v('--ansi-bright-yellow'),
    brightBlue: v('--ansi-bright-blue'),
    brightMagenta: v('--ansi-bright-magenta'),
    brightCyan: v('--ansi-bright-cyan'),
    brightWhite: v('--ansi-bright-white'),
  };
}

/** Monaco only accepts #rrggbb(aa); the CSS minifier shortens tokens such as #ffffff to #fff. */
export function expandHex(value: string): string {
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(value);
  return m
    ? `#${m
        .slice(1)
        .map((c) => (c ? c + c : ''))
        .join('')}`
    : value;
}

export type EffectiveTheme = 'dark' | 'light';

let current: EffectiveTheme = 'dark';
const listeners = new Set<(theme: EffectiveTheme) => void>();

export function currentTheme(): EffectiveTheme {
  return current;
}

/** Subscribes to theme switches (tokens are already swapped when listeners run). Returns an unsubscribe. */
export function onDidChangeTheme(listener: (theme: EffectiveTheme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let setting: 'dark' | 'light' | 'system' | null = null;
let query: MediaQueryList | null = null;
let rootEl: HTMLElement | null = null;

function apply(): void {
  if (!rootEl) return;
  const system: EffectiveTheme = query && !query.matches ? 'light' : 'dark';
  const next: EffectiveTheme = setting === 'dark' || setting === 'light' ? setting : system;
  if (rootEl.dataset['theme'] === next) return;
  rootEl.dataset['theme'] = next;
  current = next;
  for (const l of listeners) l(next);
}

/**
 * Applies `appearance.theme` (M7-T4): "dark"/"light" directly, "system" through `prefers-color-scheme` (main
 * also maps the setting onto `nativeTheme.themeSource`, so native chrome and the media query agree). Setting
 * `data-theme` on <html> swaps the CSS tokens; listeners then update xterm, Monaco, dockview and plugin views.
 */
export function setThemeSetting(value: 'dark' | 'light' | 'system'): void {
  setting = value;
  apply();
}

/** Starts theming before settings are loaded (the media query already reflects the setting via main). */
export function installThemeController(win: Window = window): void {
  rootEl = win.document.documentElement;
  query = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null;
  apply();
  query?.addEventListener('change', apply);
}
