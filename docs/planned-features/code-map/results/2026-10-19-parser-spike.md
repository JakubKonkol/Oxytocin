# Parser and packaging spike — 2026-10-19

Base revision: `bd1355d` (plus the scripts and manifest committed with this report).
Actual repository version: **0.9.9**, rather than the plan's assumed 0.9.10. No version bump is necessary for this internal stage.

## Decision

Use **web-tree-sitter 0.27.1**, with lazy loading per language, for all planned languages. The TypeScript compiler API prototype is faster, but the WASM prototype is comfortably within the parser throughput budget. This is a parser measurement, not a claim that the complete indexer meets NFR-1 or the noninterference gate; those require stage 04 measurements.

Bundle the **CommonJS** runtime entry when producing a CommonJS host. Bundling the package's ESM entry into CommonJS fails at `createRequire(import.meta.url)` before grammar initialization. The harness reproduces the working alias explicitly. Production bundling must retain this choice.

Copy the runtime WASM to `out/code-map/web-tree-sitter.wasm` and grammars to `out/code-map/grammars/` during development. Package these as `resources/code-map/` through `extraResources`; no WASM `asarUnpack` rule is necessary. The utility host JavaScript can remain inside ASAR. Use an explicit `Parser.init({ locateFile })` and load grammar bytes from the resolved resource directory. Stage 01 will wire this into the product build.

`resources/code-map/grammars.json` pins package, version, file, SHA-256 and MIT license. The copy script rejects changed assets or metadata. Grammar packages are development dependencies; **none of their install scripts is approved**. Only the WASM runtime is a production dependency. The notices generator explicitly includes all grammar licenses, including the single TypeScript package used for TS and TSX.

## Machine and method

- Windows x64; AMD Ryzen 7 5800X, 16 logical processors, 31.92 GiB RAM.
- Harness Node 24.11.1; Electron 44.4.5 with embedded Node 24.21.0.
- Every job runs in a fresh Electron `utilityProcess`, with an empty executable search path. No compiler, grammar build, project script or package manager is invoked by the measurement process.
- Parser execution disables TCP connections and `fetch`, and reads only local assets. The Windows machine itself remains connected; this does not test an OS firewall or air-gapped installer.
- No BrowserWindow is created. The launcher uses `windowsHide: true`.
- Both resources and the packaged executable live in paths containing spaces and `żółć`.
- The Windows package is a minimal Electron directory with `app.asar` and external WASM resources. Its renamed executable reports `app.isPackaged === true`; the script fails if this assertion is false. It tests the host loading arrangement, not the future full Oxytocin installer, signing or fuses.
- Fixture: 10,000 generated TS modules, 4,826,711 bytes, 70,000 counted declarations, cross-directory imports, interfaces, aliases, classes, methods and Unicode. Counts are a throughput proxy, not the final extraction accuracy corpus.
- Repository: 791 TS/JS/TSX/JSX files, 4,601,972 bytes at the measured revision with these scripts. Unsupported source/config languages are outside this benchmark.
- C#: 10,000 generated sources parsed in memory (2,116,670 bytes, 50,000 counted declarations); its timings exclude file I/O.
- Input reads use batches of 32; parsing is sequential and every tree/cursor is deleted. Raw measurements are in the adjacent JSON file.

## Results

Final run uses existing files and warm filesystem caches; each parser still builds fresh syntax trees, with no extraction cache. Times include reads and declaration traversal, excluding utility process startup.

| Build | Corpus | Parser | Total ms | Read ms | Parse/traverse ms | Peak RSS MiB |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Dev | Oxytocin | Tree-sitter | 1651.42 | 43.08 | 1608.15 | 141.47 |
| Dev | Oxytocin | TypeScript API | 705.86 | 35.59 | 670.14 | 145.94 |
| Dev | 10,000 TS | Tree-sitter | 1904.40 | 378.48 | 1524.49 | 159.69 |
| Dev | 10,000 TS | TypeScript API | 871.70 | 325.09 | 545.65 | 150.18 |
| Dev | 10,000 C# | Tree-sitter | 793.37 | 0 | 793.30 | 157.77 |
| Packaged | Oxytocin | Tree-sitter | 1555.64 | 41.85 | 1513.62 | 141.75 |
| Packaged | Oxytocin | TypeScript API | 698.30 | 40.72 | 657.43 | 146.49 |
| Packaged | 10,000 TS | Tree-sitter | 1890.05 | 400.93 | 1487.75 | 159.34 |
| Packaged | 10,000 TS | TypeScript API | 980.34 | 383.43 | 595.79 | 152.58 |
| Packaged | 10,000 C# | Tree-sitter | 918.10 | 0 | 918.04 | 157.21 |

Packaged Tree-sitter throughput is approximately 5,291 TS files/s. Worker initialization including all seven smoke parses takes 49–120 ms; fork-to-result minus corpus time is 351–508 ms across jobs. These are single observations, not percentile estimates.

All WASM assets plus the manifest: **9,923,991 bytes**. Minimal Windows benchmark directory: **406,975,263 bytes**, including Electron, the TypeScript comparison backend and bundled harness. This is not the incremental production package cost; the WASM byte counts below are the reproducible asset contribution.

### Grammar compatibility and loading

Runtime supports ABI 13–15. Every grammar loaded, accepted `setLanguage`, and parsed an original language-specific smoke fixture without errors in both modes. Installed package metadata and LICENSE files confirm MIT.

| Language | Package version | ABI | WASM bytes | First packaged load ms |
| --- | --- | ---: | ---: | ---: |
| JavaScript | tree-sitter-javascript 0.25.0 | 15 | 411,770 | 11.50 |
| TypeScript | tree-sitter-typescript 0.23.2 | 14 | 1,413,849 | 10.81 |
| TSX | tree-sitter-typescript 0.23.2 | 14 | 1,445,638 | 10.68 |
| C# | tree-sitter-c-sharp 0.23.5 | 15 | 5,350,581 | 13.04 |
| Go | tree-sitter-go 0.25.0 | 15 | 217,182 | 9.28 |
| Java | tree-sitter-java 0.23.5 | 14 | 414,641 | 8.86 |
| Python | tree-sitter-python 0.25.0 | 15 | 457,883 | 10.28 |

The sizes and versions in README section 8.8 remain accurate. Lazy loading avoids paying for unused language tables; the benchmark deliberately loads everything to test compatibility.

## Failed attempts and profiling

1. The initial ESM-to-CommonJS bundle failed before parsing; no results from that attempt are accepted.
2. A package launched as `electron.exe` reported `app.isPackaged === false`; renamed the packaged executable and added an assertion. Earlier package measurements are excluded.
3. The first sequential-read fixture run took 90,532.81 ms, followed by 5,061.44 ms on the same corpus. After bounded parallel reads, a newly rewritten fixture took 31,392.67 ms: **29,155.55 ms reading**, 2,235.41 ms parsing/traversing. A subsequent fresh-parser pass took 1,904.40 ms. The measured bottleneck was file I/O after fixture creation, not WASM; attribution to antivirus would require additional tracing. Keep this cold-file effect visible in stage 04 and do not switch parser based on unprofiled total time.
4. The pinned TSX grammar reports syntax errors in `plugins/task/src/views/task.tsx` and `src/renderer/src/features/changes/CommitBox.tsx`, while the compiler accepts the repository. This is a known compatibility limitation for stage 03: inspect error nodes, test affected constructs, and report partial coverage rather than silently dropping declarations. The fixture and C# smoke/corpus have zero syntax errors.
5. Linux `npm ci` exposed two missing optional `@emnapi` lock entries after Windows npm 11.6.2 updated the lock. Regenerated lock metadata with the container's npm; no existing dependency versions changed in this repair.

## Reproduction

```powershell
npx.cmd tsx scripts/code-map-parser-spike.ts
npx.cmd tsx scripts/code-map-parser-spike.ts --reuse-fixture
npx.cmd vitest run --project unit-node scripts/code-map-assets.test.ts
```

The default output is ignored `test-results/code-map spike żółć/`. To use another directory, pass it as a positional argument. Keep both the newly-created-file and repeat measurements when evaluating full-index cold performance.
