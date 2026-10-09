import { askAgent } from '../ask-agent/ask-agent-store';
import { type CodeContext, escapeMarkdown, type ReviewComment } from '../ask-agent/prompt-model';
import { addReviewComment } from '../review/CommentDialog';
import { useReviewStore } from '../review/review-store';
import { monaco } from './monaco-env';

/** What an editor shows: a project file, or the HEAD side of a diff. */
export interface CodeSource {
  projectId: string;
  path: string;
  languageId: string;
  /** The left (HEAD) side of a diff. */
  original?: boolean;
}

/** The selection (or the line under the cursor) as a prompt context. */
export function selectionContext(editor: monaco.editor.ICodeEditor, source: CodeSource): CodeContext | null {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return null;
  let range: monaco.IRange = selection;
  if (selection.isEmpty()) {
    const line = selection.startLineNumber;
    range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
  }
  // A selection ending at column 1 of the next line covers the lines above it only.
  const endLine =
    range.endLineNumber > range.startLineNumber && range.endColumn === 1
      ? range.endLineNumber - 1
      : range.endLineNumber;
  return {
    path: source.path,
    startLine: range.startLineNumber,
    endLine,
    code: model.getValueInRange(range),
    languageId: source.languageId,
    ...(source.original ? { original: true } : {}),
  };
}

function button(label: string, title: string, testId: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.dataset['testid'] = testId;
  b.className =
    'oxy-code-action flex h-6 items-center gap-1 rounded-badge px-2 text-small text-fg-secondary hover:bg-card-hover hover:text-fg';
  // Keep the editor's selection and focus.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

/**
 * "Ask agent" and "Add review comment" for an editor: context menu actions with shortcuts (Ctrl+L asks, Ctrl+Alt+M
 * comments) and a small toolbar that floats next to a non-empty selection.
 */
export function attachCodeActions(
  editor: monaco.editor.IStandaloneCodeEditor,
  source: () => CodeSource | null,
  opts: { comments: boolean },
): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = [];
  const ask = () => {
    const s = source();
    const context = s && selectionContext(editor, s);
    if (s && context) askAgent({ projectId: s.projectId, contexts: [{ kind: 'code', code: context }] });
  };
  const comment = () => {
    const s = source();
    const context = s && selectionContext(editor, s);
    if (s && context) addReviewComment(s.projectId, context);
  };
  disposables.push(
    editor.addAction({
      id: 'oxy.askAgent',
      label: 'Ask Agent About Selection…',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: ask,
    }),
  );
  if (opts.comments)
    disposables.push(
      editor.addAction({
        id: 'oxy.addReviewComment',
        label: 'Add Review Comment…',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM],
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 0.1,
        run: comment,
      }),
    );

  const dom = document.createElement('div');
  dom.className =
    'oxy-selection-toolbar flex items-center gap-0.5 rounded-control border border-line bg-elevated p-0.5 shadow-elevated';
  dom.dataset['testid'] = 'selection-toolbar';
  dom.append(button('✦ Ask agent', 'Ask an agent about the selection (Ctrl+L)', 'selection-ask-agent', ask));
  if (opts.comments)
    dom.append(button('+ Comment', 'Add a review comment (Ctrl+Alt+M)', 'selection-add-comment', comment));
  let position: monaco.IPosition | null = null;
  const widget: monaco.editor.IContentWidget = {
    getId: () => 'oxy.selectionToolbar',
    getDomNode: () => dom,
    getPosition: () =>
      position
        ? {
            position,
            preference: [
              monaco.editor.ContentWidgetPositionPreference.ABOVE,
              monaco.editor.ContentWidgetPositionPreference.BELOW,
            ],
          }
        : null,
  };
  editor.addContentWidget(widget);
  const update = () => {
    const selection = editor.getSelection();
    const show = !!selection && !selection.isEmpty() && editor.hasTextFocus() && source() !== null;
    position = show ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : null;
    dom.style.display = show ? '' : 'none';
    editor.layoutContentWidget(widget);
  };
  update();
  disposables.push(editor.onDidChangeCursorSelection(update));
  disposables.push(editor.onDidFocusEditorText(update));
  // Blur hides the toolbar, unless the click went to the toolbar itself.
  disposables.push(
    editor.onDidBlurEditorText(() => {
      setTimeout(() => {
        if (!dom.contains(document.activeElement)) update();
      }, 150);
    }),
  );
  disposables.push({ dispose: () => editor.removeContentWidget(widget) });
  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

/** Highlights the lines of review comments in an editor (a gutter mark and the comment on hover). */
export function trackCommentDecorations(
  editor: monaco.editor.ICodeEditor,
  comments: () => readonly ReviewComment[],
): monaco.IDisposable {
  const collection = editor.createDecorationsCollection();
  const apply = () => {
    collection.set(
      comments().map((c) => ({
        range: new monaco.Range(c.startLine, 1, c.endLine, 1),
        options: {
          isWholeLine: true,
          className: 'oxy-review-line',
          linesDecorationsClassName: 'oxy-review-gutter',
          hoverMessage: { value: `**Review comment**\n\n${escapeMarkdown(c.text)}` },
          overviewRuler: { color: accent(), position: monaco.editor.OverviewRulerLane.Left },
        },
      })),
    );
  };
  apply();
  const unsubscribe = useReviewStore.subscribe(apply);
  const modelSub = editor.onDidChangeModel(apply);
  return {
    dispose: () => {
      unsubscribe();
      modelSub.dispose();
      collection.clear();
    },
  };
}
