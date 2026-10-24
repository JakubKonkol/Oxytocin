# Code Map remediation — progress

Tracks the implementation of [remediation-plan.md](remediation-plan.md). Update this file with every commit so a
later session can resume. Work on `main`; commit and push after each completed step (CLAUDE.md rules 1–3).

## How to resume

1. Read the plan, then this file (status table and "Next").
2. Node 24 is required (`.nvmrc`); in cloud containers install it to `/opt/node24` and `export PATH=/opt/node24/bin:$PATH`.
3. Measure retrieval before and after any ranking/format change:
   `npx tsx --tsconfig tsconfig.tools.json scripts/code-map-retrieval-eval.ts` (writes
   `test-results/code-map-retrieval-eval.json`). Never tune on `heldout` questions.
4. Full validation: `npm run check`; relevant E2E: `xvfb-run -a npm run e2e -- tests/e2e/code-map.spec.ts` (and the
   bridge/visualizer specs when touched).

## Owner decisions

The owner asked to start implementing the plan (2026-10-23). Interpreted as accepting the plan's recommendations for
D2 (excerpts), D4 (deprecate `oxy_task_context`, hide status) and D5 (bounded body index). D3 (prompt-time pointers)
is implemented **off by default** until the paid A/B gate passes. D1 (paid A/B) and D6 (compiler-API TS mode) are not
started.

## Status

| Phase | Step | Status | Commit | Notes |
| ----- | ---- | ------ | ------ | ----- |
| 0 | Frozen corpus (44 questions: 22 train, 22 held-out) + `scripts/code-map-retrieval-eval.ts` | done | `423ba66` | Baseline below. |
| 0 | Per-session Code Map call accounting in the Hub / Usage Monitor | in progress | | Delegated to a sub-agent (worktree). |
| 0 | Paid A/B (D1) | not started | | Needs owner approval and budget. |
| 1 | Remove agent overhead (one locate tool, schemas, instructions, quiet output, stale-tolerant answers) | done | `8aa0555` | Default tool schemas 4,372 → 1,533 chars; all 8 tools 9,788 → 5,214. Open: Review memory defaults to on, so `oxy_task_context` + learning tools stay listed by default (rules then point to task_context only). |
| 2 | Body-aware BM25F ranking | done | `2f592ae` | Search corpus cached in records (not graph.json), pinned per generation; PageRank prior tried and rejected (no train gain). Cache +38%; index build on first query after publish 0.2–0.4 s here, 1.1–1.3 s on 10k fixture (phase 5 must address). `coverage` separates right/wrong poorly; `strong` tuned on train only. |
| 3 | Source excerpts in `oxy_find_code` | not started | | Depends on 1 and 2. |
| 4 | Prompt-time pointers via Claude Code Bridge | in progress | | Delegated; core command `oxytocin.codeMap.promptContext`, per-project setting default off, reads optional `coverage`/`strong` from phase 2. |
| 5 | Targeted refresh on query, incremental resolution | not started | | |
| 6 | TypeScript receiver types | done | `5fcf185`, `80938ba` | Repo-symbol call edges +27%, 40/40 spot-checked new edges correct; `unknown-value-type` only −5% (21k are references to local values). Fixed `@shared/*` aliases through solution-style tsconfig. Next gap: call-chain receivers (`this.f(id).m()`). |
| 7 | Decide on defaults after the A/B | not started | | |

## Measurements

Retrieval eval on this repository (`scripts/code-map-retrieval-eval.ts`, top 8, distinct files, characters of the
compact MCP answer). "hit@k" counts questions whose first expected file is within the first k files.

| Revision | Split | hit@1 | hit@3 | hit@8 | MRR | mean chars |
| -------- | ----- | ----: | ----: | ----: | --: | ---------: |
| `685a79d` baseline | all (44) | 19 | 30 | 34 | 0.561 | 1960 |
| `685a79d` baseline | train (22) | 12 | 17 | 19 | 0.655 | 1987 |
| `685a79d` baseline | held-out (22) | 7 | 13 | 15 | 0.467 | 1932 |
| `8aa0555` phase 1 | all (44) | 19 | 30 | 34 | 0.560 | 861 |
| phases 1+2+6 merged | all (44) | 27 | 38 | 43 | 0.749 | 715 |
| phases 1+2+6 merged | train (22) | 16 | 21 | 22 | 0.837 | 683 |
| phases 1+2+6 merged | held-out (22) | 11 | 17 | 21 | 0.662 | 747 |

## Log

- 2026-10-23 — Phase 0: corpus, metric library with tests, headless evaluation script; baseline recorded.
- 2026-10-23 — Phase 1 merged (`8aa0555`): check green (1,473 unit, 76 integration, 3 latency), E2E code-map/visualizer/ipc-hosts 21/21; ranks unchanged, mean answer −56%.
- 2026-10-24 — Phases 6 and 2 merged (`EXTRACTOR_VERSION` 8 for the combined record shape); check green (1,515 unit, 76 integration, 3 latency); E2E code-map + visualizer 16/16. Phase 4 and 0b agents stopped on a usage limit mid-work; their worktree branches keep the partial work.
- Finding for phase 5: every query calls `indexer.verify()`, a full metadata audit (git enumeration) of the checkout, and any change re-resolves the whole graph — the source of the 1.6–2.7 s update latency.

## Next

- Resume/finish phase 4 (`worktree-agent-a13196d230750f082`) and 0b (`worktree-agent-a6153f2d9c6970ff6`) branches and merge them.
- Then phase 3 (excerpts), phase 4 (bridge pointers, off by default), phase 5 (freshness).
