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
| 0 | Frozen corpus (44 questions: 22 train, 22 held-out) + `scripts/code-map-retrieval-eval.ts` | done | (this commit) | Baseline below. |
| 0 | Per-session Code Map call accounting in the Hub / Usage Monitor | not started | | |
| 0 | Paid A/B (D1) | not started | | Needs owner approval and budget. |
| 1 | Remove agent overhead (merged locate tool, schemas, instructions, quiet output, stale-tolerant answers) | in progress | | Delegated to a sub-agent (worktree). |
| 2 | Body-aware BM25F ranking | in progress | | Delegated to a sub-agent (worktree). |
| 3 | Source excerpts in `oxy_find_code` | not started | | Depends on 1 and 2. |
| 4 | Prompt-time pointers via Claude Code Bridge | not started | | Depends on 2 (confidence signal). |
| 5 | Targeted refresh on query, incremental resolution | not started | | |
| 6 | TypeScript receiver types | in progress | | Delegated to a sub-agent (worktree). |
| 7 | Decide on defaults after the A/B | not started | | |

## Measurements

Retrieval eval on this repository (`scripts/code-map-retrieval-eval.ts`, top 8, distinct files, characters of the
compact MCP answer). "hit@k" counts questions whose first expected file is within the first k files.

| Revision | Split | hit@1 | hit@3 | hit@8 | MRR | mean chars |
| -------- | ----- | ----: | ----: | ----: | --: | ---------: |
| `685a79d` baseline | all (44) | 19 | 30 | 34 | 0.561 | 1960 |
| `685a79d` baseline | train (22) | 12 | 17 | 19 | 0.655 | 1987 |
| `685a79d` baseline | held-out (22) | 7 | 13 | 15 | 0.467 | 1932 |

## Log

- 2026-10-23 — Phase 0: corpus, metric library with tests, headless evaluation script; baseline recorded.

## Next

- Merge the phase 1, 2 and 6 branches, re-run the eval, update the tables above.
- Then phase 3 (excerpts), phase 4 (bridge pointers, off by default), phase 5 (freshness).
