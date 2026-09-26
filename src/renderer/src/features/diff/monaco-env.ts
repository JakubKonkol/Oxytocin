// Local Monaco (no CDN): the core editor API, Monarch colouring for ~80 languages and only the editor worker
// (the diff computation) — no TS/JSON/CSS/HTML language workers (docs/plan/06-git-changes.md §7).
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
// Icon font (fold arrows, "hidden lines" controls).
import 'monaco-editor/features/codicon/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** `#rrggbb` + alpha (0–1) → `#rrggbbaa`. */
const alpha = (hex: string, a: number) =>
  /^#[0-9a-f]{6}$/i.test(hex)
    ? `${hex}${Math.round(a * 255)
        .toString(16)
        .padStart(2, '0')}`
    : hex;

let themeDefined = false;

/** `oxytocin-dark` built from the CSS tokens. */
export function ensureTheme(): void {
  if (themeDefined) return;
  themeDefined = true;
  const added = token('--git-added');
  const deleted = token('--git-deleted');
  monaco.editor.defineTheme('oxytocin-dark', {
    base: 'vs-dark',
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
    },
  });
}

export { monaco };
