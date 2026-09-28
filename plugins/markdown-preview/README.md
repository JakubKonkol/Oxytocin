# File Preview

Built-in Oxytocin plugin (id `oxytocin.markdown-preview`, formerly *Markdown Preview*): a live preview of the files
your agents write and mention — Markdown rendered, code highlighted — in a tab next to the terminal or in the right
sidebar.

- **Terminal links:** `Ctrl+click` (`⌘+click` on macOS) a file path an agent prints (`CLAUDE.md`, `src/app.ts:42`,
  `file://` hyperlinks) to open it in a preview tab; a `:line` scrolls to and marks that line. Clicking a file that is
  already open reveals its tab (or its right sidebar section) instead of opening another one. `Ctrl+Shift+click` opens
  the editor; the `terminal.fileLinks.open` setting swaps the two.
- Also from the CHANGES context menu (**Open Preview**) or with the `markdown.openPreview` command (argument: an
  absolute path; without one it lets you pick one of the project's Markdown files).
- Drag a preview tab onto the right sidebar (or use *Move to right sidebar* in the tab menu) to keep it next to every
  project; previews come back after a restart, in the workspace or the sidebar.
- **Markdown** is rendered in the backend: `markdown-it` (tables, task lists, autolinks, heading anchors) and `shiki`
  for code blocks (coloured through the theme tokens). Relative images are inlined as `data:` URIs (≤ 5 MB each,
  ≤ 20 MB per document). The view sanitizes the HTML again with DOMPurify.
- **Code** (TypeScript, JavaScript, C#, Python, Go, Rust, Java, JSON, YAML, XML/csproj, SQL, shell, … and plain text
  such as logs) is highlighted with `shiki` and shown with line numbers. Files over 2 MB and binary files are not
  previewed; files over 256 KB or 8000 lines are shown without highlighting; rendering runs in a worker thread.
- The file is watched and re-rendered 150 ms after a change; the scroll position is kept proportionally.
- Links in Markdown: `http(s)` opens in the browser, relative files of the project open in another preview (or the
  editor for other types), `#anchors` scroll.
