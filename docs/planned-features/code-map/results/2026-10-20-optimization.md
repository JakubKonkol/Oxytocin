# Edit-path and storage optimization — 2026-10-20

Base revision: `82e37a5` (stage 05), plus the optimization committed with this report. Same Linux container and harness as
`2026-10-20-csharp.md` (Intel Xeon @ 2.80 GHz, 4 threads, 15.7 GiB; packaged Electron 44.4.5 / Node 24.21.0, headless,
offline). Command: `tsx scripts/code-map-benchmark.ts <output> --only csharp-10000,fixture-10000 --runs 2 --idle-ms 300000`.
Raw data: `2026-10-20-optimization.json`.

## Changes

1. **Path-limited updates.** Watcher-only batches (≤ 500 paths, no directories, `.gitignore` or `.*proj` files) enumerate
   just those paths (`git ls-files -- :(literal)…`, or ancestor ignore rules without Git) and merge into the previous
   inventory. Skip/failure reasons are kept complete per path, so coverage numbers and diagnostics equal a full scan
   (`indexer-paths.test.ts`, with and without Git). Periodic, startup, focus and explicit reconciliations stay full.
2. **Cache store.** Extraction records are gzip-compressed (`<key>.json.gz`), written without fsync (torn records fail
   validation and are re-extracted) and indexed in memory once per engine; publication no longer walks the cache
   directory three times, and cache directories are resolved once per prefix. Older `.json` records are removed on load.
3. **One serialization per publication.** `graph.json` text and its hash are computed once and reused for `MAP.md`
   and the manifest; the in-process full-graph zod validation after assembly was removed (records are validated at the
   worker and cache boundaries, `graph.json` when read; fixture tests assert schema conformance). Edge de-duplication
   uses a field key instead of `JSON.stringify`.

## Results

| Job            | Metric             | Before (`82e37a5`) | After            |
| -------------- | ------------------ | ------------------ | ---------------- |
| TS 10k fixture | Cold build         | 41.2 s             | 31.2 s / 32.7 s  |
|                | Edit p50 / p95     | 9.7 s / 10.8 s     | 3.5 s / 4.4 s    |
|                | Map data           | 133 MiB (28.6×)    | 71 MiB (15.4×)   |
|                | Peak / retained RSS | 1,470 / 874 MiB   | 2,014 / 335 MiB  |
|                | Idle CPU (5 min)   | not measured       | 0.64 % of a core, no new generation |
| C# 10k fixture | Cold build         | 57.4 s             | 53.5 s / 45.4 s  |
|                | Edit p50 / p95     | 15.3 s / 19.0 s    | 6.9 s / 12.4 s   |
|                | Map data           | 271 MiB (46.4×)    | 126 MiB (21.7×)  |
|                | Peak / retained RSS | 2,310 / 1,154 MiB | 2,738 / 1,093 MiB |

Edits were measured after the 5-minute idle only for TS; the C# `idleCpuPercentOfCore` value in the raw data is
meaningless (idle 0 ms). Peak RSS covers the whole utility process including both cold runs, so it is not comparable
with the single-run "before" value.

## Still open (not met)

- NFR-1 (TS 10k < 30 s on the Windows reference machine): 31–33 s on this slower 4-thread container; re-measure on Windows.
- NFR-2 (edit p95 < 2 s): TS 4.4 s, C# 12.4 s. Each edit still re-assembles and re-resolves the whole graph
  (TS ~2 s, C# ~5–9 s resolve) and rewrites a 60 MB `graph.json`. Next targets: incremental resolution or a cheaper C#
  resolver pass (type lookups are recomputed per relation), and a smaller graph encoding (long repeated IDs).
- NFR-5 (< 512 MiB): not met; the host keeps every extraction record plus the graph in memory.
- NFR-6 (map < 5 % of source): not met; `graph.json` alone is ~13× the TS fixture source.
- Windows runs, terminal/Git p95 non-interference, production-installer smoke and multi-day dogfooding remain open from
  stage 04.
