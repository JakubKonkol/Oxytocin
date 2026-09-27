# Usage Monitor

Built-in Oxytocin plugin: token usage and cost of AI coding agents.

- Sources: Claude Code transcripts (`~/.claude/projects/**/*.jsonl`), Codex CLI rollouts, Gemini CLI chats and an
  opt-in local OpenTelemetry receiver.
- Everything heavy runs in a worker thread (`src/host/workers/ingest-worker.ts`) with a local SQLite database
  (`node:sqlite`) in the plugin's data folder. Only usage metadata is stored — never prompts or responses.
- Prices come from a LiteLLM snapshot (`npm run pricing:update`), refreshed daily at runtime unless
  `usage.pricing.autoUpdate` is off; `usage.pricing.overrides` (USD per 1M tokens) wins over both.
