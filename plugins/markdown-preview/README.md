# Markdown Preview

Built-in Oxytocin plugin: a live preview of Markdown files (plans, reports, READMEs written by agents) in a panel next
to the terminal (docs/plan/07-plugin-engine.md §11).

- Open it from the CHANGES context menu (**Open Preview**) or with the `markdown.openPreview` command (argument: an
  absolute path; without one it previews the active project's `README.md`).
- Rendering happens in the backend: `markdown-it` (tables, task lists, autolinks, heading anchors) and `shiki` for code
  blocks (coloured through the theme tokens). Relative images are inlined as `data:` URIs (≤ 5 MB each, ≤ 20 MB per
  document). The view sanitizes the HTML again with DOMPurify.
- The file is watched and re-rendered 150 ms after a change; the scroll position is kept proportionally.
- Links: `http(s)` opens in the browser, relative `.md` files open in another preview, other project files open in
  the editor, `#anchors` scroll.
