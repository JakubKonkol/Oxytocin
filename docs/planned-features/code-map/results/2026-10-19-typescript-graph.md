# TypeScript/JavaScript graph validation — 2026-10-19

Base revision: `b58b16e`, plus the implementation committed with this report. Windows Node 24.11.1; Docker Linux Node 24.21.0; Electron 44.4.5. Machine details are in the parser spike report.

## Scope and evidence

- Original reviewed fixture: `tests/fixtures/code-map/modules/expected.json`. Two expected file imports and five expected calls, including path aliases inherited through JSONC configuration, `.js`→`.ts` lookup, npm workspace conditional exports, named re-exports, namespace imports, instance methods and static construction. Comparison uses both file and symbol identity; equal names in different scopes are not interchangeable.
- For that fixture: imports TP=2, FP=0, FN=0; precision=1.0, recall=1.0. Calls TP=5, FP=0, FN=0; precision=1.0, recall=1.0. These numbers describe this small fixture only, not arbitrary projects or runtime execution.
- Negative cases: shadowed imported names, unknown receiver types, type-only namespace imports used as values, ambiguous overloads without an implementation and dynamic module specifiers remain unresolved. An overload with one implementation resolves to that implementation.
- Additional regressions cover literal require/import, re-export cycles, JSX components and bare `&` text recovery, local export aliases, public/private members, and private object methods.
- Golden `MAP.expected.md` checks layout, declared entry points, hubs, signatures, support levels and coverage. It is shared by Windows and Linux tests.
- Cold vs incremental vs rebuild: `graph/engine.test.ts` compares graph and Markdown bytes, tests deletions and removal of old edges, cache pruning, corrupt graph/cache recovery, and stale declaration retention after syntax errors. The parser-thread suite verifies actual bundled worker execution, cancellation, malformed-response rejection, deadline termination and subsequent recovery.
- Electron E2E runs in Docker/Xvfb: an actual utility host configures a checkout, parses through its worker thread, publishes artifacts and updates relations after a changed export. No native desktop window is launched.

## Format decisions

1. Web binding offsets are UTF-16. The astral-character regression verifies that a declaration's column equals its JavaScript string offset, rather than its UTF-8 byte offset. Native Tree-sitter offsets must not be confused with this binding API.
2. Canonical graph text strips BOM and converts CRLF/CR to LF before computing graph file hashes, byte/line counts and extraction. Runtime fingerprints retain raw byte hashes and metadata to detect physical edits. Consumers verifying `graph.files[].sha256` must use the same canonical text normalization. This makes the requested cross-platform line-ending determinism possible without discarding raw freshness evidence.
3. Extraction cache keys include relative path, canonical content hash, extractor version, grammar versions and runtime version. Relative path is necessary because the record contains stable path-derived IDs. No absolute root, stat timestamps, PID or machine name is stored in a record.
4. Syntax-error snapshots intentionally retain historical declarations with `stale: true`. Such recovery snapshots depend on the previous good source revision. Byte determinism comparisons apply to the same valid source/configuration; they cannot erase history while also preserving historical declarations. Tools and source navigation must preserve and respect the stale flags.
5. Configuration is parsed as data into a selected runtime model. Raw package scripts/configuration text never enters the extraction cache. Module resolution only targets indexed records; excluded/outside files and external package implementations are never opened by the resolver.
6. Rebuild bypasses the cache and republishes fresh records even when the resulting graph bytes are unchanged. Routine metadata audits can update the manifest without changing graph generation. New watcher events during publication remain pending and keep status updating.

## Limits and remaining validation

- Parser work runs in one reusable thread with a 2.5 s file deadline and a 256 MiB V8 old-generation limit. A blocked parser is terminated without blocking host health pings. File/global counts and projected on-disk size are guarded.
- Unrecognized receiver types, dynamic/computed calls and unsupported module configurations are explicit unresolved entries. This is a syntax/binding graph, not a typechecker or complete runtime call graph.
- The pinned TSX grammar can recover imperfectly around bare ampersands in JSX text. Those files are reported as syntax-error coverage; declarations are incomplete or explicitly stale, never presented as fully current.
- Full-index throughput, change latency, idle CPU, terminal/Git noninterference, retained memory and artifact/source size ratio are stage 04 measurements. The parser-only spike is not a substitute for these gates.
- C#, Go, Java and Python remain file-only until their respective stages. MCP, UI, public plugin API and learnings are not part of this internal stage.
