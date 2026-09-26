# S5 — Claude Code session registry and terminal signals

**Date:** 2026-09-26 · **Environment:** Linux x64, Claude Code 2.1.283 (remote entrypoint).

## Observed

The registry lives in `${CLAUDE_CONFIG_DIR ?? ~/.claude}/sessions/<pid>.json`, one file per running session. A real
entry (values redacted) had these fields:

| Field | Example / meaning |
|---|---|
| `pid` | pid of the Claude Code process (the file name) |
| `sessionId` | UUID of the conversation |
| `cwd` | working directory |
| `startedAt`, `procStart` | start timestamp (ms) and the process start ticks (pid reuse guard) |
| `version` | `2.1.283` |
| `kind` | `interactive` |
| `entrypoint` | `remote` (`cli` for a terminal session) |
| `peerProtocol`, `peerFeatures`, `pidDomain`, `messagingSocketPath` | inter-session messaging — ignored |
| `name`, `nameSource`, `nameSince` | session title (shown in the tab tooltip) |
| `status`, `statusUpdatedAt` | `busy` while a turn runs |
| `updatedAt` | last write |

`claude agents --json` returns an array with `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status` —
the same keys as the file, so both go through one tolerant parser (`zod` with `.passthrough()`).

## Implementation consequences

- Only `<digits>.json` files are read; partially written files are skipped until the next watch event.
- Status mapping: `busy`/`shell` → `working`, `idle` → `idle`, `waiting` → `waiting` (+ `waitingFor`), anything
  else → `unknown` with a single debug log per unknown value so the mapping can be extended.
- Matching by pid works with the nearest agent process found by the process monitor (on Windows the pid of
  `claude.exe`, or of `node.exe` when started from npm; the command-line rule covers the latter).
- The CLI fallback runs every 5 s only while the directory is missing and at least one Claude agent is detected.

## Not verified here

This environment could not start additional interactive Claude Code sessions, so the following remain unconfirmed
and are handled defensively:

- the exact `status` values during a tool-permission prompt, a `!` shell command and a question from the agent
  (`waiting`/`shell` are assumed from the plan), and whether `waitingFor` exists;
- whether Claude Code emits `OSC 9;4` progress, OSC titles or BEL in xterm.js (the signal path is implemented
  and tested with the fake agent; OSC 9;4 state 4 is treated as `waiting`).

To be re-checked on Windows 11 with a real session before v0.1; the mapping lives in
`src/main/services/agents/claude-registry.ts`.
