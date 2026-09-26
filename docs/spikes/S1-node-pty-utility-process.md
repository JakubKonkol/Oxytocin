# S1 — node-pty 1.1.0 in an Electron 44 utilityProcess (incl. packaged build)

**Date:** 2026-09-26 · **Environment:** Linux x64 container (Ubuntu, glibc), Electron 44.4.5 (Node 24.21), node-pty 1.1.0.

## What was checked

1. `utilityProcess.fork()` of a host script that `require`s node-pty and spawns `bash -c "echo …; printf red; exit 3"`.
2. The same app packaged with `electron-builder --linux dir` (`asar: true`, `asarUnpack: ["**/node_modules/node-pty/**"]`,
   `npmRebuild: false`) and started from `release/linux-unpacked`.

## Results

| Check | Result |
|---|---|
| node-pty loads in utilityProcess (dev) | ✅ output `hello-from-pty\r\n` + ANSI red, exit code 3 |
| node-pty loads in the packaged app from `app.asar.unpacked` | ✅ identical output and exit code |
| Linux install | node-pty 1.1.0 has no Linux prebuild → compiled by `node-gyp` during `npm install` (gcc/make/python present). The resulting N-API addon works in Electron without `electron-rebuild`. |
| npm 11 install scripts | npm 11 does not run install scripts unless whitelisted: `allowScripts` in `package.json` must list `node-pty` and `@parcel/watcher` (and `esbuild`). |

## Not verified here (needs a Windows 11 machine)

- `useConptyDll: true/false`, bundled `conpty.dll` / `OpenConsole.exe` paths after packaging (`electron-builder --win --dir`).
- Previously confirmed by the owner outside this session: node-pty 1.1.0 under Electron 44 with `useConptyDll: true`
  spawns `cmd.exe /c echo` correctly (docs/plan/README.md §5.2). The packaged Windows check moves to the packaged smoke test (M5-T5 / M6-T8).

## Decision

No change to ADR-004/ADR-005. Keep `asarUnpack` for node-pty and `npmRebuild: false`. Linux builds compile node-pty
at `npm ci` time (risk R9 stands; revisit node-pty 1.2 with Linux prebuilds once stable).
