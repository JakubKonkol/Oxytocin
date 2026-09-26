# S7 — Codex CLI and Gemini CLI: log formats, limits and telemetry

Date: 2026-09-26 · Gemini CLI 0.61.0 (`@google/gemini-cli-core` source) · Codex CLI (documented format)

## Setup

Neither CLI has credentials in this environment, so no real sessions could be recorded. Gemini CLI is open source
JavaScript: its recording and telemetry code was read from the published npm package. Codex CLI is a Rust binary;
its rollout format comes from its documentation/source knowledge and is marked **to verify** with a real session.

## Gemini CLI

- **Location:** `${GEMINI_CLI_HOME ?? ~}/.gemini/tmp/<project id>/chats/`. Since the project registry
  (`~/.gemini/projects.json`), `<project id>` is a **short id**, not the hash — older versions used
  `sha256(projectRoot)` as the folder name. Main sessions: `session-<timestamp>-<sessionId[0:8]>.jsonl`; subagent
  sessions: `chats/<parentSessionId>/<sessionId>.jsonl` → scan `chats/` recursively.
- **Records (JSONL, append-only):**
  - first line: metadata `{ sessionId, projectHash, startTime, lastUpdated, kind: 'main' | 'subagent', directories? }`;
  - messages `{ id, timestamp, type: 'user' | 'gemini' | …, content, thoughts?, tokens?, model?, toolCalls? }` —
    a message is **appended again with the same id** when it changes (tokens arrive after the text) → last one wins;
  - `{ $set: { … } }` metadata updates; `$set.messages` is a checkpoint that replaces the message list.
  - There is no separate `message_update` record type (the plan's assumption) — updates are full re-appends.
- **Legacy files** `*.json`: one JSON document with `messages[]`, rewritten in full.
- **Tokens** (`recordMessageTokens`): `input = promptTokenCount` (includes cached), `output = candidatesTokenCount`,
  `cached = cachedContentTokenCount`, `thoughts = thoughtsTokenCount`, `tool = toolUsePromptTokenCount`,
  `total = totalTokenCount = input + output + thoughts + tool` → mapping of §8 confirmed: `tokens.input = input −
  cached + tool`, `cacheRead = cached`, `output = output + thoughts`, `reasoning = thoughts`.
- **projectHash** = `sha256(projectRoot)` of the path string as given (no normalization) — still written into every
  session's metadata, so attribution matches `sha256(rootPath)` against the metadata field, not the folder name.
- **Telemetry:** `http` protocol uses `@opentelemetry/exporter-{metrics,logs}-otlp-http` → **OTLP/JSON** (no protobuf
  decoder needed). Metrics `gemini_cli.token.usage` (attributes `model`, `type`), event `gemini_cli.api_response`.
  The SDK is a `NodeSDK` with default resource detection → `OTEL_RESOURCE_ATTRIBUTES` is merged into the resource
  (terminal/project attribution works).

## Codex CLI (to verify)

- `${CODEX_HOME ?? ~/.codex}/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, archived copies under
  `archived_sessions/`.
- Lines `{ timestamp, type, payload }`: `session_meta` (`id`, `cwd`, `cli_version`), `turn_context` (`model`, `cwd`,
  `effort`), `response_item` (content — ignored), `event_msg` with `payload.type = 'token_count'`:
  `info.total_token_usage` / `info.last_token_usage` `{ input_tokens, cached_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens }` (input includes cached, output includes reasoning) and
  `rate_limits.{primary, secondary}.{used_percent, window_minutes, resets_at | resets_in_seconds}`. `info` can be
  `null` (a rate-limit-only update); `token_count` may be emitted twice with the same totals.

## Consequences

- Plan §8 corrected: no `message_update` records; upsert by message id, `$set.messages` checkpoints replace the set.
- The OTLP receiver handles JSON (+ gzip) only; protobuf is not required (M6-T5).
- Fixtures: `tests/fixtures/usage/{codex,gemini}/` are hand-written from these formats (incl. duplicate
  `token_count`, a rate-limit-only update, a total reset, archived duplicates, re-appended Gemini messages, a subagent
  file and a legacy `.json` session); `tests/fixtures/usage/expected.json` holds the reference totals computed by an
  independent script.
