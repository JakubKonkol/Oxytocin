# Code Map implementation plan

This is a future execution brief. The current research task changes documentation only. Re-read root `CLAUDE.md` and inspect current source before implementation; paths below are integration targets, not permission to bypass current architecture.

## Delivery rules

- Implement original code and fixtures; use the upstream research to understand behavior, not as a copying task.
- Work on `main` under repository rules. Do not introduce rollout flags. Per-project opt-in is the requested product behavior.
- Steps 1–4 form the first complete release: enable, index, update, query through MCP, inspect status, disable, recover. Internal preparatory commits may be small, but do not release a visible nonfunctional switch.
- Keep parser and retrieval code outside main, shared contracts free of Node/Electron APIs, and every boundary validated. Every new subscription/job has disposal and cancellation behavior.
- For implementation commits, follow the repository's checks, relevant E2E, build/start, changelog, attribution, and push workflow. Do not add predicted savings to UI copy.

## 1. Prove the parser and package boundary

Dependencies: none. Output: a documented engineering decision and a packaged parser fixture.

- Prototype the pinned WASM runtime and JS/TS/TSX grammars in a utility process. Use original fixtures with imports, shadowing, re-exports, arrow functions, JSX, Unicode, syntax errors, and large files.
- Compare cold start, parse throughput, memory, and bundle size in development and packaged Windows builds, including non-ASCII paths and a machine without a compiler/toolchain. Disable network during the packaged test.
- Audit all shipped grammar/runtime licenses and hashes. Resolve runtime/grammar ABI compatibility and asset lookup in ASAR/resources. Record versions and reproducible grammar generation provenance.
- Decide WASM versus native based on measurements. If WASM misses the targets in [validation](validation.md), first profile extraction and serialization before introducing native modules.
- Define source offset conversion and cache-version inputs. Freeze initial supported syntax and explicitly unresolved forms.

Likely files: `electron.vite.config.ts`, `electron-builder.yml`, `package.json`, lockfile, third-party notices, `src/code-map-host`, build scripts, TypeScript and ESLint boundaries.

Exit: packaged offline fixture passes on Windows; no runtime download, toolchain, or project command execution; no parser work on main. Record actual numbers and remaining gaps.

## 2. Build the deterministic index and lifecycle

Depends on 1. Output: a supervised service with a stable internal query contract.

- Add `src/shared/domain/code-map.ts` schemas and `src/shared/rpc/contracts/code-map-host.ts` for configure/remove/status/query/rebuild/pause and compact status events. Include errors, generation metadata, coverage, and cancellation semantics.
- Add `src/code-map-host/{index,enumerate,watch,scheduler,extract,resolve,store,query}` modules as needed; avoid precreating abstraction layers without callers.
- Add `src/main/services/code-map/code-map-service.ts` to own checkout registrations and host lifecycle. Register through the app's existing service/bootstrap pattern; inspect actual bootstrap location before editing.
- Implement per-file hashed extraction reuse, full relation resolution, immutable snapshot publication, corruption recovery, budgets, and cleanup. Implement watcher-first initialization and event-sequence tracking.
- Use saved working-tree contents, including untracked files, rather than HEAD. Apply ignores, file caps, canonical-path containment, and nested-repository boundaries consistently to enumeration and query paths.
- Implement explicit freshness modes and status/error envelopes. Ensure restart reattaches enabled projects and reconciles before latest queries.

Exit: cold and incremental graphs are equivalent for the same tree; rapid edits/deletes/renames/branch changes produce no dangling edges; restart and interrupted writes recover; non-Git projects and Git-disabled projects work; selected source excerpts never knowingly mismatch their snapshot.

## 3. Connect MCP and every supported checkout context

Depends on 2. Output: agents can discover and use bounded structural context.

- Add a dedicated `src/main/services/mcp/code-map-tools.ts` builder rather than expanding the large core-tools file indefinitely. Inject service dependencies into `mcp-hub.ts`; reuse registry policies and call logs.
- Implement the four tools in [design](design.md), argument/output validation, response budgets, error codes, and cancellation. Add an availability predicate analogous to resource tools without pretending Code Map is a database resource.
- Add a short conditional MCP initialization brief and capability descriptions. Keep the tool descriptions useful for already-connected sessions. Reuse client configuration export; test generic HTTP MCP access without requiring a new CLI installer.
- Implement strict map-specific checkout resolution. Do not globally change existing core tool project-selection behavior as an incidental cleanup.
- Inspect `src/main/services/ensemble/ensemble-service.ts`, `ensemble-tools.ts`, and the Hub bridge. Extend authenticated role context with the actual worktree root/identity where needed. Explicitly bridge read-only map tools and verify no selector can escape that checkout.
- Stop and revoke map access when a project is disabled or a task/worktree disappears. Do not return the main checkout map as a fallback for a missing worktree map.

Exit: tests cover two projects and two divergent worktrees; queries select the requested code even while another project is active; authenticated Ensemble roles cannot query a sibling checkout; disabled maps reject direct calls even if cached tool definitions remain in the client.

## 4. Complete project settings and first-release verification

Depends on 2–3. Output: a complete usable first release.

- Extend `ProjectSettingsSchema`, project-settings draft/patch helpers, and their tests. Update all alternate settings writers so new fields round-trip correctly.
- Add Code Map tab/status UI, progress, coverage and diagnostics, rebuild/pause/cache actions, exclusions, and copyable instructions. Use CSS tokens and existing settings controls. Wire IPC through channels/contracts/router/preload, with sender validation.
- Verify lifecycle when switching projects, restarting the app, changing root, disabling mapping during a query, and disabling MCP while keeping local indexing enabled.
- Run the correctness and packaged smoke matrix in [validation](validation.md), and the repository's `npm run check`, `npm run build`, and relevant Playwright suites. Add feature-specific E2E tests and run existing project-settings, MCP Hub, Ensemble, and host tests affected by the change.
- Update CHANGELOG only for the implemented behavior, dependency notices, user documentation, and the feature status in this directory. Record measured limits and unresolved coverage honestly.

Exit: the acceptance checklist is green; terminal/Git responsiveness remains within measured targets; users can enable, observe, use, and disable the feature without manually modifying their repository.

## 5. Improve based on evidence

Each item is a separate follow-up with its own usable outcome:

| Extension                                              | Start only when                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Python/Go and further languages                        | Real project demand exists and parser/resolver fixtures plus license/packaging checks are ready.                           |
| Visual explorer                                        | Core query API and node/edge limits are stable; navigation value is demonstrated.                                          |
| Semantic TS/LSP enrichment                             | Measured missed/incorrect relations justify lifecycle and memory cost.                                                     |
| SQLite or incremental relation updates                 | Profiling shows JSON publication/full resolution is the limiting factor.                                                   |
| Static Markdown export or managed instruction adapters | Agent clients demonstrably cannot use the existing MCP flow adequately; export staleness and file ownership are specified. |
| Graph-aware ranking                                    | Labeled retrieval tests improve beyond the lexical baseline without regressions across scopes.                             |

LLM summaries, conversation memory, hosted collaboration, and automatic per-prompt hooks are separate proposals, not deferred requirements of the first Code Map release.
