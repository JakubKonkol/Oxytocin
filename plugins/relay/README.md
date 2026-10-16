# Relay

Hands a project's work from one AI agent to the next — Claude Code, Codex CLI, Gemini CLI or any detected agent, on
any of your accounts (*Settings → AI Agents → Accounts*). Open it from the **+** menu (*Tools → Relay*).

- **Hand off at the limit.** When an agent finishes its turn and its account's 5-hour (or weekly) limit is at least
  the threshold (90% by default), the next free agent in the order whose account still has room gets the hand-off
  prompt, e.g. *"Continue the implementation where Claude (main) left off; the status is in TODO.md"*. Nobody free →
  Relay waits, also for the first agent's limit to start over, so the work can go round.
- **Review after each turn.** When an author finishes a turn that changed files, the reviewer gets the review prompt
  with the names of the changed files. Turns that end while the reviewer works are reviewed together; the reviewer's
  own turns start nothing.

Relay types one short prompt per hand-off and nothing else: no status messages, no system prompts, no diffs (agents
read the files themselves). It only types into an agent that waits for input and never over a question on screen.

Limits come from the **Usage Monitor** (Claude Code: *Usage → Settings → Show Claude subscription limits*; Codex CLI:
after its first turn), per account.

Permissions: `projects.read`, `agents.read` (agents, accounts, limits), `terminals.write` (typing the prompt),
`git.read` (which files a turn changed).
