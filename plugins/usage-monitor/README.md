# Usage Monitor

Built-in Oxytocin plugin: token usage and cost of AI coding agents.

- Sources: Claude Code transcripts (`~/.claude/projects/**/*.jsonl`), Codex CLI rollouts, Gemini CLI chats and an
  opt-in local OpenTelemetry receiver.
- Everything heavy runs in a worker thread (`src/host/workers/ingest-worker.ts`) with a local SQLite database
  (`node:sqlite`) in the plugin's data folder. Only usage metadata is stored — never prompts or responses.
- Prices come from a LiteLLM snapshot (`npm run pricing:update`), refreshed daily at runtime unless
  `usage.pricing.autoUpdate` is off; `usage.pricing.overrides` (USD per 1M tokens) wins over both.
- Claude subscription limits (opt-in, `usage.claudeLimits.statusLine`): Claude Code passes the 5-hour and weekly
  limits of Pro/Max plans to its status line (`rate_limits`). The plugin sets `statusLine` in Claude Code's user
  `settings.json` to a script in `<claude config>/oxytocin-statusline/` (`sh`, or PowerShell on Windows without
  Git Bash) that saves input carrying `rate_limits` to `usage.json` there and then runs the previous status line
  command; turning the option off restores the previous `statusLine`. The worker watches `usage.json`
  (`src/host/collectors/claude-statusline.ts`). With Claude Code billing set to `subscription` the limits get their
  own bars in the sidebar and replace the cost in the status bar.
