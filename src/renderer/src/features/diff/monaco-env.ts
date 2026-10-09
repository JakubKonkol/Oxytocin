// Local Monaco (no CDN): the core editor API, Monarch colouring for ~80 languages and only the editor worker
// (the diff computation) — no TS/JSON/CSS/HTML language workers.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
// Icon font (fold arrows, "hidden lines" controls).
import 'monaco-editor/features/codicon/register';
// Editing features of the code editor and the editable side of diffs (find/replace, folding, comments, multiple
// cursors, word completion…). Language services (IntelliSense) are left out: they need their own workers.
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/dnd/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/insertFinalNewLine/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/links/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/readOnlyMessage/register';
import 'monaco-editor/features/smartSelect/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/stickyScroll/register';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/wordPartOperations/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { currentTheme, type EffectiveTheme, expandHex, onDidChangeTheme } from '../../lib/theme';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const token = (name: string) => expandHex(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
/** `#rrggbb` + alpha (0–1) → `#rrggbbaa`. */
const alpha = (hex: string, a: number) =>
  /^#[0-9a-f]{6}$/i.test(hex)
    ? `${hex}${Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')}`
    : hex;

const defined = new Set<EffectiveTheme>();

/**
 * `oxytocin-dark` / `oxytocin-light` built from the CSS tokens of the current theme; returns the theme name.
 * A theme switch defines the other one (tokens are swapped by then) and re-themes every editor.
 */
export function ensureTheme(): string {
  const theme = currentTheme();
  const name = `oxytocin-${theme}`;
  if (defined.has(theme)) return name;
  defined.add(theme);
  const added = token('--git-added');
  const deleted = token('--git-deleted');
  monaco.editor.defineTheme(name, {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': token('--bg-card'),
      'editor.foreground': token('--text-primary'),
      'editorLineNumber.foreground': token('--text-muted'),
      'editorLineNumber.activeForeground': token('--text-secondary'),
      'editor.lineHighlightBackground': token('--bg-card-hover'),
      'editor.selectionBackground': token('--accent-muted'),
      'editorGutter.background': token('--bg-card'),
      'editorWidget.background': token('--bg-elevated'),
      'editorWidget.border': token('--border-default'),
      'scrollbarSlider.background': alpha(token('--text-muted'), 0.25),
      'scrollbarSlider.hoverBackground': alpha(token('--text-muted'), 0.4),
      'diffEditor.insertedTextBackground': alpha(added, 0.22),
      'diffEditor.removedTextBackground': alpha(deleted, 0.22),
      'diffEditor.insertedLineBackground': alpha(added, 0.1),
      'diffEditor.removedLineBackground': alpha(deleted, 0.1),
      'diffEditorGutter.insertedLineBackground': alpha(added, 0.18),
      'diffEditorGutter.removedLineBackground': alpha(deleted, 0.18),
      'diffEditor.diagonalFill': alpha(token('--border-default'), 0.6),
      'diffEditor.unchangedRegionBackground': token('--bg-surface'),
      'diffEditor.unchangedRegionForeground': token('--text-muted'),
      'editorGlyphMargin.background': token('--bg-card'),
      'minimap.background': token('--bg-card'),
      'editorStickyScroll.background': token('--bg-card'),
      'editorStickyScrollHover.background': token('--bg-card-hover'),
      'editor.findMatchHighlightBackground': alpha(token('--warning'), 0.25),
      'editor.findMatchBackground': alpha(token('--warning'), 0.45),
      'editorBracketMatch.background': alpha(token('--accent'), 0.18),
      'editorBracketMatch.border': alpha(token('--accent'), 0.5),
      'editorSuggestWidget.background': token('--bg-elevated'),
      'editorSuggestWidget.border': token('--border-default'),
      'editorSuggestWidget.selectedBackground': token('--accent-muted'),
      'editorHoverWidget.background': token('--bg-elevated'),
      'editorHoverWidget.border': token('--border-default'),
      'input.background': token('--bg-input'),
      'input.border': token('--border-default'),
      focusBorder: token('--border-focus'),
      'menu.background': token('--bg-elevated'),
      'menu.foreground': token('--text-primary'),
      'menu.selectionBackground': token('--accent-muted'),
      'menu.selectionForeground': token('--text-primary'),
      'menu.separatorBackground': token('--border-subtle'),
      'menu.border': token('--border-default'),
    },
  });
  return name;
}

onDidChangeTheme(() => monaco.editor.setTheme(ensureTheme()));

export { monaco };
