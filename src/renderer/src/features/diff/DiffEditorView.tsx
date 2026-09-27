import { useEffect, useRef } from 'react';
import type { FileDiffContent } from '@shared/domain/git';
import { diffRegistry } from './diff-registry';
import { ensureTheme, monaco } from './monaco-env';

export interface DiffViewOptions {
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  hideUnchanged: boolean;
}

let modelCounter = 0;

/** Monaco DiffEditor (read-only) for one file; content updates keep the scroll/fold state. */
export default function DiffEditorView({
  panelId,
  content,
  options,
}: {
  panelId: string;
  content: FileDiffContent;
  options: DiffViewOptions;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = ensureTheme();
    const editor = monaco.editor.createDiffEditor(host, {
      theme,
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 900,
      renderOverviewRuler: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      automaticLayout: false,
      diffAlgorithm: 'advanced',
    });
    editorRef.current = editor;
    const go = (direction: 'next' | 'previous') => editor.goToDiff(direction);
    for (const side of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
      side.addCommand(monaco.KeyCode.F7, () => go('next'));
      side.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => go('previous'));
    }
    diffRegistry.set(panelId, {
      goToChange: go,
      text: () => ({
        original: modelsRef.current?.original.getValue() ?? '',
        modified: modelsRef.current?.modified.getValue() ?? '',
      }),
      changeCount: () => editor.getLineChanges()?.length ?? 0,
      currentLine: () => {
        const pos = editor.getModifiedEditor().getPosition()?.lineNumber;
        const changes = editor.getLineChanges() ?? [];
        const current = changes.find(
          (c) =>
            pos !== undefined &&
            pos >= c.modifiedStartLineNumber &&
            pos <= Math.max(c.modifiedStartLineNumber, c.modifiedEndLineNumber),
        );
        return (current ?? changes[0])?.modifiedStartLineNumber || pos;
      },
    });
    // Layout by hand (hidden workspaces / panels have no size).
    const observer = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) editor.layout();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      diffRegistry.delete(panelId);
      editor.dispose();
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
      editorRef.current = null;
    };
  }, [panelId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const original = content.original ?? '';
    const modified = content.modified ?? '';
    const current = modelsRef.current;
    if (current && current.original.getLanguageId() === content.languageId) {
      // Live update: keep scroll position and folded regions.
      const viewState = editor.saveViewState();
      if (current.original.getValue() !== original) current.original.setValue(original);
      if (current.modified.getValue() !== modified) current.modified.setValue(modified);
      if (viewState) editor.restoreViewState(viewState);
      return;
    }
    const id = ++modelCounter;
    const next = {
      original: monaco.editor.createModel(
        original,
        content.languageId,
        monaco.Uri.parse(`oxy-diff://original/${id}/${content.path}`),
      ),
      modified: monaco.editor.createModel(
        modified,
        content.languageId,
        monaco.Uri.parse(`oxy-diff://modified/${id}/${content.path}`),
      ),
    };
    editor.setModel(next);
    current?.original.dispose();
    current?.modified.dispose();
    modelsRef.current = next;
  }, [content]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      renderSideBySide: options.sideBySide,
      ignoreTrimWhitespace: options.ignoreWhitespace,
      hideUnchangedRegions: {
        enabled: options.hideUnchanged,
        contextLineCount: 3,
        minimumLineCount: 5,
        revealLineCount: 20,
      },
    });
  }, [options]);

  return <div ref={hostRef} data-testid="diff-editor" className="h-full w-full" />;
}
