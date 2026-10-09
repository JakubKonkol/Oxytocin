import { useEffect, useRef } from 'react';
import { useLatest } from '../../lib/use-latest';
import type { FileDiffContent } from '@shared/domain/git';
import { useReviewStore } from '../review/review-store';
import { attachCodeActions, type CodeSource, trackCommentDecorations } from './code-actions';
import { diffRegistry } from './diff-registry';
import { ensureTheme, monaco } from './monaco-env';

export interface DiffViewOptions {
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  hideUnchanged: boolean;
}

let modelCounter = 0;

/**
 * Monaco DiffEditor for one file. The right side (the file on disk) can be edited when `editable` is set: Ctrl+S
 * saves, the arrows between the sides revert single changes. Content updates keep the scroll and fold state and
 * never replace unsaved edits.
 */
export default function DiffEditorView({
  panelId,
  projectId,
  content,
  options,
  editable = false,
  onDirtyChange,
  onSave,
  autoHeight,
}: {
  panelId: string;
  projectId?: string;
  content: FileDiffContent;
  options: DiffViewOptions;
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSave?: () => void;
  /** Grows with the content instead of filling the parent (the review list); reports the height. */
  autoHeight?: (height: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const savedVersion = useRef(0);
  const dirtyRef = useRef(false);
  /** Set while the text is replaced from disk: that is not an edit. */
  const applying = useRef(false);
  const callbacks = useLatest({ onDirtyChange, onSave, autoHeight });
  const sourceRef = useLatest({ projectId, path: content.path, languageId: content.languageId });
  const contentRef = useLatest(content);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = ensureTheme();
    const editor = monaco.editor.createDiffEditor(host, {
      theme,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 900,
      renderOverviewRuler: !callbacks.current.autoHeight,
      renderMarginRevertIcon: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      automaticLayout: false,
      diffAlgorithm: 'advanced',
      ...(callbacks.current.autoHeight
        ? { scrollbar: { alwaysConsumeMouseWheel: false, vertical: 'hidden' as const, handleMouseWheel: true } }
        : {}),
    });
    editorRef.current = editor;
    const go = (direction: 'next' | 'previous') => editor.goToDiff(direction);
    const sides = [editor.getOriginalEditor(), editor.getModifiedEditor()] as const;
    for (const side of sides) {
      side.addCommand(monaco.KeyCode.F7, () => go('next'));
      side.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => go('previous'));
    }
    editor
      .getModifiedEditor()
      .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave?.());
    const source = (original: boolean) => (): CodeSource | null => {
      const s = sourceRef.current;
      return s.projectId
        ? { projectId: s.projectId, path: s.path, languageId: s.languageId, ...(original ? { original } : {}) }
        : null;
    };
    const comments = (original: boolean) => () => {
      const s = sourceRef.current;
      if (!s.projectId) return [];
      return (useReviewStore.getState().comments[s.projectId] ?? []).filter(
        (c) => c.path === s.path && !!c.original === original,
      );
    };
    const disposables = [
      attachCodeActions(sides[0], source(true), { comments: true }),
      attachCodeActions(sides[1], source(false), { comments: true }),
      trackCommentDecorations(sides[0], comments(true)),
      trackCommentDecorations(sides[1], comments(false)),
    ];
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
      modifiedValue: () => modelsRef.current?.modified.getValue() ?? null,
      markSaved: () => {
        savedVersion.current = modelsRef.current?.modified.getAlternativeVersionId() ?? 0;
        if (dirtyRef.current) {
          dirtyRef.current = false;
          callbacks.current.onDirtyChange?.(false);
        }
      },
      discardEdits: () => {
        const models = modelsRef.current;
        if (!models) return;
        dirtyRef.current = false;
        applying.current = true;
        models.modified.setValue(contentRef.current.modified ?? '');
        applying.current = false;
        savedVersion.current = models.modified.getAlternativeVersionId();
        callbacks.current.onDirtyChange?.(false);
      },
      revealLine: (line) => {
        const side = editor.getModifiedEditor();
        side.revealLineInCenter(line);
        side.setPosition({ lineNumber: line, column: 1 });
        side.focus();
      },
      focus: () => editor.getModifiedEditor().focus(),
    });
    // Height follows the content (review list): the taller side.
    const reportHeight = () => {
      const report = callbacks.current.autoHeight;
      if (!report) return;
      const h = Math.max(sides[0].getContentHeight(), sides[1].getContentHeight());
      report(Math.min(h + 2, 4000));
    };
    disposables.push(sides[0].onDidContentSizeChange(reportHeight), sides[1].onDidContentSizeChange(reportHeight));
    disposables.push(editor.onDidUpdateDiff(reportHeight));
    // Layout by hand (hidden workspaces / panels have no size).
    const observer = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) editor.layout();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      disposables.forEach((d) => d.dispose());
      diffRegistry.delete(panelId);
      editor.dispose();
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
      editorRef.current = null;
    };
  }, [panelId, callbacks, contentRef, sourceRef]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const original = content.original ?? '';
    const modified = content.modified ?? '';
    const current = modelsRef.current;
    if (current && current.original.getLanguageId() === content.languageId) {
      // Live update: keep scroll position and folded regions; unsaved edits are never replaced.
      const viewState = editor.saveViewState();
      if (current.original.getValue() !== original) current.original.setValue(original);
      if (!dirtyRef.current && current.modified.getValue() !== modified) {
        applying.current = true;
        current.modified.setValue(modified);
        applying.current = false;
        savedVersion.current = current.modified.getAlternativeVersionId();
      }
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
    savedVersion.current = next.modified.getAlternativeVersionId();
    next.modified.onDidChangeContent(() => {
      if (applying.current) return;
      const dirty = next.modified.getAlternativeVersionId() !== savedVersion.current;
      if (dirty !== dirtyRef.current) {
        dirtyRef.current = dirty;
        callbacks.current.onDirtyChange?.(dirty);
      }
    });
    editor.setModel(next);
    current?.original.dispose();
    current?.modified.dispose();
    modelsRef.current = next;
  }, [content, callbacks]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !editable });
  }, [editable]);

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
