# JSON Formatter

Built-in Oxytocin plugin: a panel that formats, minifies and validates JSON (API responses, agent output, config
snippets).

- Open it from the **+** menu of a workspace group (*Tools → JSON Formatter*) or the right sidebar's **Add tool** menu;
  drag its tab into the right sidebar to keep it next to the scratchpad.
- **Format** pretty-prints with 2 spaces, 4 spaces or tabs, optionally with sorted keys; **Minify** removes the
  whitespace; **Copy** copies the text. `Ctrl+Enter` formats.
- Invalid JSON shows the error with its line and column. The text is kept with the panel (also across restarts).
- Everything runs in the view: the plugin has no backend and needs no permissions.
