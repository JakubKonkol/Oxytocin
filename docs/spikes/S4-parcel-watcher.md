# S4 — `@parcel/watcher` in a utilityProcess

**Date:** 2026-09-26 · **Environment:** Linux x64 (inotify backend), Electron 44.4.5 utilityProcess, `@parcel/watcher` 2.6.0 (prebuilt `watcher-linux-x64-glibc`).

## Setup

A temporary repo with `node_modules/` containing 500 packages × 100 files (50,000 files) and `src/` with 200 files.
After subscribing, an "npm install" burst creates 20,000 files in 200 new `node_modules` packages, 50 files in `src/`
are modified and a file is created at a path of 857 characters.

## Results

| Metric | `ignore: ['node_modules']` | no ignore |
|---|---|---|
| `subscribe()` time | 4 ms | 226 ms |
| Events delivered | 51 (50 edits + deep file) | 19,111 |
| Callback batches | 2 | 3 |
| Last event after burst start | 451 ms | 760 ms |
| CPU (user + system, incl. the writer in the same process) | 0.4 s | 1.5 s |

- Ignoring `node_modules` at the native level removes practically all event load during installs.
- Without ignore, not all 20,050 events arrive (inotify cannot watch newly created directories before files appear in them)
  — confirms the need for the periodic refresh safety net (docs/plan/06 §3.3) and for triggering a full `git status`
  rather than trusting individual events.
- Long paths (857 chars) are reported normally on Linux.

## Not verified here (needs Windows 11)

`ReadDirectoryChangesW` backend, paths > 260 characters on Windows, network drives. To be checked manually before v0.1.

## Decision

ADR-013 confirmed. Watcher events are only a trigger for `RefreshScheduler`; the list itself always comes from `git status`.
