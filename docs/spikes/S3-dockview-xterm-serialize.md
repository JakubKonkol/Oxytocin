# S3 — dockview `renderer: 'always'` + xterm 6 + SerializeAddon

**Date:** 2026-09-26 · **Environment:** Linux x64, Node 24.21, `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0.

## Part A — SerializeAddon restores the alternate buffer (done)

A headless terminal received 40 coloured lines, then entered the alternate screen (`CSI ?1049h`), drew a full-screen UI,
moved the cursor, and enabled several modes. `serialize({ scrollback: 1000 })` was written into a fresh headless terminal.

| Property | Restored? |
|---|---|
| Active buffer = alternate, alternate buffer text | ✅ |
| Normal buffer (scrollback with colours) underneath | ✅ |
| Cursor position | ✅ |
| Application cursor keys (`?1h`), bracketed paste (`?2004h`) | ✅ |
| Mouse tracking mode (`?1000h`), focus reporting (`?1004h`) | ✅ |
| Cursor visibility (`?25l`) | ❌ not serialized |
| SGR mouse encoding (`?1006h`) | ❌ not serialized |

Snapshot size for 40 lines + a full screen ≈ 1 KB.

**Decision:** `HeadlessMirror.serialize()` appends the missing mode sequences after the addon output: `CSI ?25l` when the
cursor is hidden and the active mouse encoding (`?1006h` / `?1015h` / `?1005h`), read from the headless terminal state.
Covered by a unit test in M1-T1.

## Part B — dockview panel moves do not reset xterm / iframes

Deferred to M2 where the real `ProjectWorkspace` exists: M2-T2's E2E test ("drag a panel to another group — buffer
and process intact") and M5-T3's E2E test ("moving a panel does not reload the iframe") are the acceptance for this part.
Mitigation stays as in ADR-006: `defaultRenderer: 'always'`, layout code isolated in `features/layout`.
