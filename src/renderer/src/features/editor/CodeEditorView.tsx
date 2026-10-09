import { useEffect, useRef } from 'react';
import { useLatest } from '../../lib/use-latest';
import { useReviewStore } from '../review/review-store';
import { attachCodeActions, selectionContext, trackCommentDecorations } from '../diff/code-actions';
import type { CodeContext } from '../ask-agent/prompt-model';
import { ensureTheme, monaco } from '../diff/monaco-env';

export interface CodeViewOptions {
  fontSize: number;
  wordWrap: boolean;
  minimap: boolean;
}

/** What the panel can do with its editor. */
export interface CodeViewApi {
  getValue(): string;
  /** Replaces the text (a reload from disk) keeping the scroll position; the result counts as saved. */
  load(text: string): void;
  markSaved(): void;
  revealLine(line: number, column?: number): void;
  focus(): void;
  selection(): CodeContext | null;
}

let modelCounter = 0;

/** Monaco editor for one project file (Monarch colouring, find/replace, folding, multiple cursors…). */
export default function CodeEditorView({
  projectId,
  path,
  languageId,
  initialText,
  eol,
  options,
  apiRef,
  onDirtyChange,
  onSave,
  onReady,
}: {
  projectId: string;
  path: string;
  languageId: string;
  initialText: string;
  eol?: 'crlf' | 'lf' | 'mixed' | undefined;
  options: CodeViewOptions;
  apiRef: { current: CodeViewApi | null };
  onDirtyChange: (dirty: boolean) => void;
  onSave: () => void;
  onReady?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useLatest({ onDirtyChange, onSave, onReady });
  const source = useLatest({ projectId, path, languageId });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const model = monaco.editor.createModel(
      initialText,
      languageId,
      monaco.Uri.parse(`oxy-file://${++modelCounter}/${path}`),
    );
    if (eol === 'crlf') model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    const editor = monaco.editor.create(host, {
      model,
      theme: ensureTheme(),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: options.fontSize,
      wordWrap: options.wordWrap ? 'on' : 'off',
      minimap: { enabled: options.minimap },
      automaticLayout: false,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
      fixedOverflowWidgets: true,
      padding: { top: 6 },
    });
    editorRef.current = editor;
    let savedVersion = model.getAlternativeVersionId();
    let dirty = false;
    let applying = false;
    const setDirty = (next: boolean) => {
      if (next === dirty) return;
      dirty = next;
      callbacks.current.onDirtyChange(next);
    };
    const contentSub = model.onDidChangeContent(() => {
      if (!applying) setDirty(model.getAlternativeVersionId() !== savedVersion);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    const actions = attachCodeActions(
      editor,
      () => ({ projectId: source.current.projectId, path: source.current.path, languageId: source.current.languageId }),
      { comments: false },
    );
    const decorations = trackCommentDecorations(editor, () =>
      (useReviewStore.getState().comments[source.current.projectId] ?? []).filter(
        (c) => c.path === source.current.path && !c.original,
      ),
    );
    apiRef.current = {
      getValue: () => model.getValue(),
      load: (text) => {
        const viewState = editor.saveViewState();
        applying = true;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
        applying = false;
        savedVersion = model.getAlternativeVersionId();
        setDirty(false);
        if (viewState) editor.restoreViewState(viewState);
      },
      markSaved: () => {
        savedVersion = model.getAlternativeVersionId();
        setDirty(false);
      },
      revealLine: (line, column) => {
        const position = { lineNumber: Math.max(1, line), column: Math.max(1, column ?? 1) };
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
        editor.focus();
      },
      focus: () => editor.focus(),
      selection: () => selectionContext(editor, source.current),
    };
    const observer = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) editor.layout();
    });
    observer.observe(host);
    callbacks.current.onReady?.();
    return () => {
      observer.disconnect();
      actions.dispose();
      decorations.dispose();
      contentSub.dispose();
      apiRef.current = null;
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // The editor is created once per file; later text arrives through `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, languageId]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: options.fontSize,
      wordWrap: options.wordWrap ? 'on' : 'off',
      minimap: { enabled: options.minimap },
    });
  }, [options]);

  return <div ref={hostRef} data-testid="code-editor" className="h-full w-full" />;
}
