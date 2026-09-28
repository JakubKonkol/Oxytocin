import { PreviewError, previewKind, readPreviewText, renderCodeToHtml } from './code';
import { renderFile } from './render';

export interface RenderedPreview {
  html: string;
  kind: 'markdown' | 'code';
}

/** Renders a previewed file: Markdown with inlined images, anything else as (highlighted) code. */
export async function renderPreview(filePath: string, rootPath: string): Promise<RenderedPreview> {
  const kind = previewKind(filePath) ?? { kind: 'code' as const, language: null };
  if (kind.kind === 'markdown') return { html: await renderFile(filePath, rootPath), kind: 'markdown' };
  return { html: renderCodeToHtml(await readPreviewText(filePath), kind.language), kind: 'code' };
}

/** A render failure as it crosses the worker boundary. */
export interface RenderFailure {
  message: string;
  /** `ENOENT` for a missing file. */
  code?: string;
  /** A message meant for the user (too large, binary). */
  expected?: boolean;
}

export function toFailure(e: unknown): RenderFailure {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return {
    message: e instanceof Error ? e.message : String(e),
    ...(typeof code === 'string' ? { code } : {}),
    ...(e instanceof PreviewError ? { expected: true } : {}),
  };
}
