# S2 — `node:sqlite` in a utilityProcess and in worker_threads

**Date:** 2026-09-26 · **Environment:** Linux x64, Electron 44.4.5 (Node 24.21), dev and packaged (`linux-unpacked`).

## What was checked

- `require('node:sqlite').DatabaseSync` inside a utilityProcess: `PRAGMA journal_mode=WAL`, 100,000 inserts in one transaction.
- A `worker_threads` Worker started from the utilityProcess opens the same database file (WAL), inserts a row and counts.
- The utilityProcess reads the count after the worker wrote.

## Results

| Check | Result |
|---|---|
| `DatabaseSync` in utilityProcess | ✅ `journal_mode` = `wal`, 100,000 rows |
| `DatabaseSync` in a worker thread inside the utilityProcess | ✅ sees 100,000 rows, inserts one (100,001) |
| Cross-connection visibility (WAL) | ✅ main connection sees 100,001 |
| Time (whole spike incl. 100k inserts) | ≈ 110–125 ms |
| Packaged app | ✅ same results |

No experimental warning was printed. WAL on Windows was not verified in this session (no Windows machine); the owner
previously confirmed `node:sqlite` works under `ELECTRON_RUN_AS_NODE` on Windows.

## Decision

ADR-012 confirmed: `node:sqlite` in a worker thread of the Plugin Host. better-sqlite3 stays a fallback only.
