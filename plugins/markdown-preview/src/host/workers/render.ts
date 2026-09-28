import { parentPort } from 'node:worker_threads';
import { renderPreview, toFailure } from '../render-preview';

// Rendering (markdown-it, shiki) runs here: highlighting a large file takes seconds and must not block the Plugin
// Host, which the other built-in plugins share.
parentPort?.on('message', (m: { id: number; filePath: string; rootPath: string }) => {
  renderPreview(m.filePath, m.rootPath).then(
    (result) => parentPort?.postMessage({ id: m.id, ok: true, result }),
    (e: unknown) => parentPort?.postMessage({ id: m.id, ok: false, error: toFailure(e) }),
  );
});
