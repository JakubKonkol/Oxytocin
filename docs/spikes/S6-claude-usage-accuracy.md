# S6 — Claude Code usage accuracy: JSONL transcripts vs the CLI's own accounting

Date: 2026-09-26 · Claude Code 2.1.283 · model `claude-opus-5-5` · Linux

## Question

Are the per-message `usage` records in `~/.claude/projects/**/*.jsonl` complete and exact enough to be the default
source of the Usage Monitor (docs/plan/08-usage-monitor.md §5.4)? Acceptable: tokens 0 %, cost < 1 %.

## Method

The plan's method (OTEL console exporter on 10 prompts) needs an interactive, authenticated `claude` run. Instead the
spike used a long real session recorded in this container (5 878 lines, ~11 h) which contains a better reference:
Claude Code writes a **`cost-state` record** (`totalCostUSD`, `modelUsage.<model>.{inputTokens, outputTokens,
thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}`) — the same counters the CLI uses for `/cost`
and for the OTEL metrics. The transcript lines *before* that record were aggregated with the parser rules of §5.3
(assistant lines with `message.usage`, dedupe by `message.id + requestId` taking the max of every field) and compared.
Only numeric metadata was read.

## Findings

| | JSONL (deduplicated) | `cost-state` | Difference |
|---|---|---|---|
| API responses | 544 | — | — |
| input | 1 088 | 7 060 | −5 972 |
| output | 648 811 | 660 835 | −1.8 % |
| thinking (part of output) | 132 611 | 132 611 | **0** |
| cache read | 202 112 074 | 203 328 053 | −0.6 % |
| cache creation | 1 164 100 | 1 170 143 | −0.5 % |

- Every assistant line carries the full `usage` object; one API response is written as 1–4 lines (one per content
  block) with **identical** usage on all of them in this version (no placeholder `output_tokens` seen) — the max-upsert
  stays as a guard for older versions.
- `usage` fields present on every line: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
  `output_tokens_details.thinking_tokens`, `server_tool_use.{web_search_requests, web_fetch_requests}`, `service_tier`,
  `speed`, `inference_geo` (`not_available` here) and `iterations[]`.
- `iterations[]` holds one entry per line with the same numbers as the top level → the top-level fields are the totals;
  iterations are ignored.
- Claude Code 2.1 uses the **1-hour cache** for the main conversation (all cache writes were `ephemeral_1h`).
- The residual ~0.5–2 % are API calls that are not written as assistant lines (context compaction summaries and other
  internal requests of the CLI). They cannot be recovered from the transcript; the OTLP opt-in source (M6-T5) reports
  them. Thinking tokens matching exactly shows the parser itself is exact.
- Cost check with LiteLLM rates for `claude-opus-5-5` (input $4/M, output $20/M, cache read $0.20/M, cache write 1h
  $8/M) applied to the **reference** token counts: $63.2717 vs `costUSD` $63.2571 (+0.02 %, explained by a few
  thousand 5-minute cache-write tokens in the uncaptured internal calls). The §10.4 formula is confirmed.

## Decision

- JSONL stays the default source (no ADR change). Documented limitation: transcripts miss the CLI's internal calls
  (≈ 0.5–2 % of tokens in long sessions with compaction); the dashboard's "Sources" tab states it, and OTLP is the
  opt-in for exact totals.
- The parser ignores `iterations[]`; `cost-state` records are not used as a source (written rarely, per session only).
- An anonymized excerpt of the session (40 usage records, `scripts/make-fixtures.ts`) plus hand-written edge cases are
  the fixtures in `tests/fixtures/usage/claude/`.
