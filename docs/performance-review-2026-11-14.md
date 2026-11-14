# Performance and memory review — 2026-11-14

This review measured memory and background work in the running app (Linux, Electron 44, `xvfb`) instead of only
reading code. Every probe ran the built app through Playwright, forced garbage collection over the DevTools protocol
before each measurement and compared heaps after repeating an action many times. A heap that grows by the same
amount every round and does not come back after collection is a leak; a one-time increase is a cache.

## Confirmed problem and repair

| Area | Finding | Repair and regression coverage |
| --- | --- | --- |
| Diff editor | Every diff ever opened stayed in memory after its tab closed: both editors, both text models (the whole file twice), the diff view model and the panel's React tree. 120 diffs of a 2,000-line file grew the window's heap from 40 MB to 63 MB and it never went down. Two Monaco 0.57 defects: `setModel({ original, modified })` creates a view model it keeps a reference to and never disposes, and the overview ruler's autorun observes the layout, which observes the overview ruler, so `dispose()` never releases it. Through Monaco's global emitters (theme changes, sash size, menus) they retained everything. | `DiffEditorView` creates the view model with `createViewModel` and disposes it with the models, and turns the overview ruler off before disposing the editor. The same probe now stays at 39–40 MB. A unit test checks that every view model is disposed and that the ruler goes before `dispose()`. |
| Sidebar layout | Not a memory issue, but found while measuring: section heights were overwritten on every start (late plugin views and window resizes moved height to the bottom section and that layout was saved). | `PaneSizeKeeper` keeps the heights the user chose and fits them in proportion; E2E test across restarts. |

## Measured without findings

| Probe | Result |
| --- | --- |
| 75 terminals opened and closed (15 rounds of 5) | Renderer heap 17 → 18 MB, main heap flat at 22 MB, DOM node count unchanged. |
| 120 files opened and closed in the code editor | Renderer heap 36 → 38 MB (Monaco's tokenizer and language caches; no editors or models retained). |
| 33 plugin panels (Usage, Run, Task) opened and closed | Renderer heap 16 → 17 MB, no frames left behind. |
| 55 switches between 5 mounted projects | Renderer heap 20 → 21 MB, DOM node count unchanged (workspace keep-alive works as designed). |
| 3 projects × 3 terminals (perf E2E) | 433 MB private memory in total (budget 450 MB): main 100 MB, renderer 110 MB, GPU 71 MB, Plugin Host 71 MB, PTY Host 32 MB, Workspace Host 22 MB. Main's JavaScript heap is only 22 MB; the rest is Electron's own baseline. |
| Idle for 20 s with a terminal open | Main 0.02 CPU-s, hosts ≤ 0.03 CPU-s. The renderer's work came from the terminal cursor blink and the Usage status item's spinner, shown while an agent is working (the probe picked up a live agent session); both are CSS animations that a GPU composites. |

Reviewed in code: timers (all cleared on dispose, git refresh only for the focused window's active project,
relative-time clocks stop when not needed), terminal output forwarding to plugins (only for terminals a plugin
watches), the Usage Monitor's log collector (incremental tail with persisted cursors, 1 GB per-file cap, files outside
the backfill window skipped) and scrollback (5,000 lines by default, bounded in both the renderer and the PTY Host).

## Possible next steps (not done)

- The Usage Monitor rescans its log folders every 30 s even while `fs.watch` works (a `readdir` of the folder tree and
  a `stat` plus a SQLite lookup per log file). With thousands of Claude Code session files this is steady background
  I/O in the Plugin Host's worker; a longer interval while the watchers are healthy would cut it.
- The perf E2E's memory figure (433 MB) is close to its 450 MB budget, so a modest increase elsewhere will push it
  over. It is reported only, not enforced.
