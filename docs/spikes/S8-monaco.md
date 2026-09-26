# S8 — Monaco (editor worker, codicon font) under `app://` with the production CSP

**Date:** 2026-09-26 · **Environment:** Linux x64, Electron 44.4.5, monaco-editor 0.57.0, Vite 7.3 (electron-vite 5).

## Setup

- `monaco-editor/editor/editor.api` (core API only, no language services), `monaco-editor/basic-languages/monaco.contribution`
  (Monarch colouring) and `monaco-editor/features/codicon/register` (icon font).
- `window.MonacoEnvironment = { getWorker: () => new EditorWorker() }` with `editor.worker?worker` (Vite module worker).
- The diff editor is code-split: `DiffEditorView` is loaded with `React.lazy` on the first opened diff.
- Production build served by the `app://oxytocin` protocol handler with the shell CSP
  (`script-src 'self'`, `worker-src 'self' blob:`, `font-src 'self' data:`, `style-src 'self' 'unsafe-inline'`).

## Results

| Check | Result |
|---|---|
| Worker starts under `app://` (module worker, same origin) | ✓ — the diff is computed (line changes reported), no CSP violations in the console |
| Codicon font (`codicon.ttf`, bundled asset) | ✓ after importing `features/codicon/register` — the core API alone does not pull in the font CSS (icons rendered as boxes) |
| Monarch colouring without language workers | ✓ |
| Bundle | `DiffEditorView` chunk ≈ 5.3 MB (+ 130 KB CSS), `editor.worker` ≈ 560 KB; the initial renderer bundle is unchanged |
| CRLF | HEAD content via `git cat-file --filters` + disk content: only real changes are shown |

## Consequences

- No CSP changes needed; `worker-src blob:` stays for other workers but Monaco does not use it.
- Always import `features/codicon/register` together with `editor.api`.
- Verified automatically by the E2E test `git.spec.ts` ("clicking a change opens its diff…"), which runs against the
  production build.
