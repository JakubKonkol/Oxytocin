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
