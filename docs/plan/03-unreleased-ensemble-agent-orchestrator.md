# Plan 03 — Ensemble: tasks run by a team of AI agents

Status: **unreleased, not started** · Depends on: Oxytocin's MCP server (Plan 01, released in 0.6.5 —
`src/main/services/mcp/`), background terminals (`CreateTerminalRequest.background`), agent states
(`src/main/services/agents/`) and the Claude Code Bridge hooks (`plugins/claude-code-bridge/`).

This document is written for the agent (or person) who implements the feature. Read it completely, read the files
listed in [Current state](#current-state-read-these-files-first), then follow
[Implementation steps](#implementation-steps) in order. Every step ends in a working, released-quality state (see the
owner's rules in `CLAUDE.md`: work on `main`, no feature flags, changelog for user-visible changes, an E2E test for
every user-visible feature). Fill in the [Verification log](#verification-log) as you go — several CLI details of
third-party agents must be checked against the installed versions before they are relied on.

## Goal and use case

A developer wants a feature built by several agents with different strengths instead of one long session. They open
**Ensemble** from the **+** menu of a workspace group, create a task *"Add CSV export to the reports page"*, and set
up a team:

| Agent | Role | CLI | Model | Effort |
|---|---|---|---|---|
| Ada | Planner | Claude Code | Opus | xhigh |
| Linus | Implementer | Claude Code | Opus | medium |
| Grace | Reviewer | Claude Code | Sonnet | high |
| Ken | Second opinion | Codex CLI | (a GPT model) | high |

They give each agent a role prompt, write one general prompt for the whole team, and arrange the pipeline
*Plan → (approve plan) → Implement ⇄ Review (max 3 rounds) → Tests → (approve) → Finish*. They press **Start**.
Oxytocin creates a git worktree for the task, starts every agent in its own background terminal with its own model and
effort, hands each stage's work to the right agent, carries results from one agent to the next, and shows the whole
run as a live pipeline. The developer can peek into any agent's terminal at any moment, type into it, answer questions
the agents ask, approve the plan, and finally merge the branch — while `claude` started anywhere else still runs with
their own default model and settings.

### Decisions already made (by the owner)

- Ensemble is a **new tool in the "+" menu** of the center workspace (the same menu as the scratchpad and plugin
  panels). It must look great and have a high-quality UX — this is a flagship feature, not a settings form.
- A user creates a **task**, builds a **pipeline**, adds **agents** comfortably, gives each agent a **role** and a
  **prompt** by hand, and writes a **general prompt** shared by the whole team.
- Per agent: **which AI (CLI), model, effort** and related options.
- While it runs: a **live visualization of the pipeline** and the ability to **watch what every agent does**.
- **Several Claude Code agents from the same account with different models and efforts** is the primary case;
  other agents (Codex CLI, Gemini CLI, OpenCode, …) must work too.
- **Isolation:** nothing the orchestrator does may change the user's defaults. After a run, `claude` started outside
  Ensemble uses the user's default model, effort and settings.

### Decisions taken by the plan author (change them if the owner objects)

- **Core feature, not a plugin.** The pipeline view embeds live terminals (the renderer ⇄ PTY Host MessagePort,
  `TerminalView`), which plugin iframes cannot host; it also needs worktrees, PTY pastes from main and core MCP
  tools. A read-only plugin API for tasks can follow later.
- **A deterministic conductor, not an LLM lead.** The pipeline is a state machine in main. Agents do the work;
  Oxytocin decides who works next, what they get, and when a stage is done. (Claude Code's own *agent teams* use an
  LLM lead, inherit one effort level for all teammates, need tmux/iTerm2 for split panes and are Claude-only — see
  [Research summary](#research-summary).)
- **Real interactive terminals.** Every agent runs its normal TUI in a background terminal (not `claude -p`), so the
  user can watch it and take over at any time. Headless helper steps are a later option.
- **Structured communication through Oxytocin's MCP server** (`oxy_ensemble_*` core tools), not by scraping
  terminal output. Oxytocin only types short prompts into a terminal, and only when the agent is idle.
- **One git worktree per task** by default (the user's checkout is never touched); *current checkout* is an
  explicit opt-in for small sequential tasks.
- The name **Ensemble** (a group of performers playing one piece). Vocabulary used in the UI and code: *task*,
  *agent* (a member of the ensemble), *role*, *pipeline*, *stage*, *handoff*, *gate*, *run*.

### Non-goals (for this plan)

- Agents on other machines or in the cloud; scheduling tasks at a time of day.
- A visual DAG editor with arbitrary edges. Pipelines are a sequence of stages; a stage may run agents in parallel
  or loop between two agents (that covers the useful shapes; see [Pipeline model](#pipeline-model)).
- Account and provider management (several Claude accounts, OpenRouter, Ollama). The data model leaves a slot for an
  *agent profile* (`profileId`), which a separate plan ("Agent profiles") fills; v1 uses the CLI's default account.
- Automatic merging without the user's approval.

## Research summary

Checked on 2026-10-01 against the Claude Code docs (links in [References](#references)). Re-check before relying on
anything marked *verify*.

| Mechanism | What it gives | Use in Ensemble |
|---|---|---|
| `claude --model <alias or id>` | Model for this session only; overrides `model` settings and `ANTHROPIC_MODEL` | **Per-agent model** |
| `claude --effort low\|medium\|high\|xhigh\|max` | Effort for this session only; does not persist | **Per-agent effort** (levels depend on the model) |
| `/model` + Enter, `/model <name>`, `/effort` + Enter | **Persist** to `~/.claude/settings.json` | **Never sent by Ensemble** (isolation) |
| `--settings '<json>'` | Overrides settings keys for this session only | Per-role settings without touching files |
| `--session-id <uuid>`, `--name <name>` | Known session id and display name | Map session ↔ agent; resume after a restart |
| `--append-system-prompt-file <path>` | Extra system prompt from a file | Ensemble protocol + general prompt + role prompt |
| `--permission-mode`, `--disallowedTools`, `--allowedTools` | Permission mode and tool rules per session | Read-only reviewers, `acceptEdits` implementers |
| `--mcp-config <json>` | Extra MCP servers for this session | Fallback when Oxytocin is not connected globally |
| `--resume <id>` | Resume a session | Continue an agent after an app restart |
| Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) | Lead + teammates, mailboxes, task list | Not used: one effort for all, tmux needed, Claude-only, LLM lead |
| Cross-session messaging (`SendMessage`, inbox socket / named pipe) | Claude sessions on one machine message each other | Not relied on (Claude-only, invisible to the conductor); do not disable it |
| Channels (`notifications/claude/channel`) | An MCP server pushes events into a running session | Research preview, stdio only, warning dialog on every start → **later** |
| `claude -p --input-format stream-json --output-format stream-json` | Fully programmatic sessions | No TUI to watch → only for future headless helper steps |

Several sessions on one account run concurrently, each with its own model and effort; they share the account's
usage limits (5-hour and weekly), which the UI must make visible.

Other CLIs (verify every flag in step 5 and record it in the verification log):

| CLI | Model | Effort / reasoning | Read-only | Role prompt | Done signal |
|---|---|---|---|---|---|
| Codex CLI | `-m <model>` | `-c model_reasoning_effort=<level>` | `--sandbox read-only` | first message (no system-prompt flag known) | `oxy_ensemble_submit`; `notify` config hook later |
| Gemini CLI | `-m <model>` | none known | approval mode flag (verify) | first message | `oxy_ensemble_submit` + output heuristics |
| OpenCode | `--model provider/model` (verify) | provider-specific | agent config (verify) | first message | `oxy_ensemble_submit` + heuristics |
| Custom | command template | — | — | first message | `oxy_ensemble_submit` |

Similar tools (Conductor, Claude Squad, Vibe Kanban, Parallel Code, Agent Orchestrator) all isolate agents with git
worktrees, which confirms that choice. As far as public descriptions go, they focus on parallel independent agents,
not on role pipelines with a model and effort per role and terminals you can watch on Windows.

## Current state (read these files first)

| What | Where |
|---|---|
| "+" menu of a workspace group and **Add tool** of the sidebars; tool definitions (`scratchpad`, `plugin:<type>`) | `src/renderer/src/features/tools/AddMenus.tsx`, `tools.ts` |
| Center panel kinds and their React components (add `ensemble` here) | `src/renderer/src/features/layout/panel-registry.ts` (`PanelKind`), `ProjectWorkspace.tsx` (`components`) |
| Sidebar tools schema (`scratchpad` / `plugin`) | `src/shared/domain/ui-state.ts` (`SidebarToolSchema`) |
| Terminals in main: creation with `env`, `initialCommand`, `background` | `src/main/services/terminals/terminal-service.ts`, `src/shared/domain/terminal.ts` (`CreateTerminalRequestSchema`) |
| Environment composition (strips `CLAUDECODE` etc. for terminals) | `src/main/services/terminals/env-composer.ts` |
| Writing to a PTY from main | `src/main/index.ts` (`hosts.pty.call('write', …)`), `src/pty-host/` (`headless-mirror.ts` knows the terminal modes) |
| Live terminal view in the renderer | `src/renderer/src/features/terminals/TerminalView.tsx`, `terminal-registry.ts`, `pty-channel.ts` |
| Paste into an agent (bracketed paste) | `src/renderer/src/features/scratchpad/scratchpad-actions.ts` (`sendToAgent`) |
| Agent detection and states (`starting/working/idle/waiting`), source priorities | `src/main/services/agents/agent-service.ts`, `claude-registry.ts`, `rules.ts`, `src/shared/domain/agent.ts` |
| Claude Code hooks → exact states (`Stop`, `Notification`, `PostToolUse`, `UserPromptSubmit`, …) | `plugins/claude-code-bridge/src/host/` |
| MCP hub: core tools, policies, caller context (`X-Oxytocin-Terminal` header), hidden tools, instructions per terminal | `src/main/services/mcp/` (`mcp-hub.ts`, `core-tools.ts`, `caller-context.ts`, `tool-registry.ts`, `client-registration.ts`) |
| Ask the user in a dialog / notify (used by `oxy_ask_user`, `oxy_notify_user`) | `core-tools.ts` deps, `src/main/services/notifications/` |
| Git in the Workspace Host (`--no-optional-locks`, porcelain v2, diffs) | `src/workspace-host/git/` (`exec.ts`, `compute-status.ts`, `file-diff.ts`, `discover.ts`) |
| Monaco diff view | `src/renderer/src/features/diff/` |
| JSON stores with atomic writes | `src/main/services/storage/` |
| Settings schema (add `ensemble.*`) | `src/shared/domain/settings.ts` |
| Calling a plugin command from main (e.g. `projectRunner.resolveUrl`) | `src/main/index.ts`, `src/main/services/plugins/plugin-host-service.ts` (`executeCommand`) |
| Usage Monitor (sessions, costs, Claude subscription limits) | `plugins/usage-monitor/src/host/` |
| Attention badge, status bar items, `Ctrl+Shift+J` | `src/renderer/src/features/attention/` |
| UI kit, tokens, animations | `src/renderer/src/ui/`, `src/renderer/src/styles/tokens.css`, `animations.css` |
| Fake Claude Code for E2E (writes registry states) | `tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js`, `tests/e2e/agents.spec.ts` |
| E2E helpers (launch, MCP client, terminals, git) | `tests/e2e/helpers/` |

## Design

### Architecture

```
Renderer: Ensemble panel (builder · pipeline · agents wall · activity · changes · artifacts)
   │ ipc ensemble:*  (zod contracts)                     ▲ events ensemble:changed / ensemble:event
   ▼                                                     │
main: EnsembleService ─────────────────────────────────────────────────────────────────────
   ├─ TaskStore            tasks, templates, runs (JSON, atomic) + artifacts folder per task
   ├─ Conductor            pure state machine (reducer) + effects runner, one per running task
   ├─ AgentAdapters        claude-code · codex · gemini-cli · opencode · custom  → launch spec
   ├─ LaunchComposer       command line, env, prompt files (isolation rules)
   ├─ PromptDelivery       waits for idle → PTY paste (+ submit) → confirms the agent started working
   ├─ WorkspaceManager     worktree add/remove, setup commands, copy untracked files, checkpoints
   └─ EnsembleTools        oxy_ensemble_* core tools in the McpHub (role-token checked)
        │                         │                          │
   TerminalService (background)   AgentService (states)      Workspace Host (git worktree, status, diff)
        │
   PTY Host: agent TUIs (claude, codex, …) ──MCP (HTTP, token)──▶ McpHub ─▶ EnsembleTools
```

- The **Conductor is pure**: `reduce(state, event) → { state, effects[] }`. Effects (start agent, deliver prompt,
  create worktree, run command, notify, ask user) are executed by `EnsembleService` and their results come back as
  events. This makes the whole pipeline logic unit-testable without terminals.
- Main does no heavy work: git runs in the Workspace Host, terminals in the PTY Host. No synchronous I/O.
- Code lives in `src/main/services/ensemble/`, shared types in `src/shared/domain/ensemble.ts`, the conductor
  reducer in `src/shared/ensemble/` (pure TS, testable in `unit-node`), the UI in
  `src/renderer/src/features/ensemble/`.

### Data model (`src/shared/domain/ensemble.ts`, zod)

Sketch — adjust names to the code base, keep everything versioned (`v: 1`) and tolerant to unknown fields
(`.passthrough()` where data is read back from disk; see plan 02's round-trip note).

```ts
const AgentKind = z.enum(['claude-code', 'codex', 'gemini-cli', 'opencode', 'custom']);
const RolePreset = z.enum(['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'docs', 'custom']);

const EnsembleAgent = z.object({
  id: z.string(),                                   // stable within the task: a-z0-9-
  name: z.string().min(1).max(40),                  // "Ada"; shown on cards and in messages
  role: z.object({
    preset: RolePreset,
    label: z.string().min(1).max(40),               // "Planner", "Security reviewer"
    color: z.string(),                              // a palette token name, not a raw colour
    icon: z.string().optional(),                    // lucide icon name
  }),
  cli: AgentKind,
  profileId: z.string().optional(),                 // future "Agent profiles" plan (account / provider)
  model: z.string().optional(),                     // alias or full id; empty = the CLI's default
  effort: z.string().optional(),                    // adapter-specific level; empty = model default
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']).default('default'),
  readOnly: z.boolean().default(false),             // no edits (adapter maps it: disallowed tools / sandbox)
  rolePrompt: z.string().max(20_000).default(''),
  extraArgs: z.array(z.string()).default([]),       // advanced, shown with a warning
  env: z.record(z.string(), z.string()).default({}),// advanced; never secrets in v1
  customCommand: z.string().optional(),             // cli = custom: template with {{model}} {{promptFile}} …
});

const OutputKind = z.enum(['plan', 'implementation', 'review', 'test-report', 'research', 'free']);
const StageBase = z.object({ id: z.string(), title: z.string().max(60), instruction: z.string().max(20_000) });
const Stage = z.discriminatedUnion('kind', [
  StageBase.extend({ kind: z.literal('agent'), agentId: z.string(), output: OutputKind }),
  StageBase.extend({ kind: z.literal('parallel'), agentIds: z.array(z.string()).min(2), output: OutputKind,
                     join: z.enum(['all', 'first']).default('all') }),
  StageBase.extend({ kind: z.literal('loop'), workerId: z.string(), checkerId: z.string(),
                     maxRounds: z.number().int().min(1).max(10).default(3),
                     checkerInstruction: z.string().max(20_000) }),
  StageBase.extend({ kind: z.literal('gate'), show: z.array(z.enum(['plan', 'diff', 'review', 'tests', 'summary'])),
                     onReject: z.enum(['back-to-previous', 'stop']).default('back-to-previous') }),
  StageBase.extend({ kind: z.literal('command'), command: z.string(), cwd: z.enum(['worktree']).default('worktree'),
                     onFail: z.object({ agentId: z.string().optional(), maxAttempts: z.number().int().max(5) }) }),
]);

const EnsembleTask = z.object({
  v: z.literal(1),
  id: z.string(), projectId: z.string(),
  title: z.string().min(1).max(120),
  description: z.string().max(50_000),              // the brief, Markdown
  generalPrompt: z.string().max(20_000).default(''),
  attachments: z.array(z.object({ path: z.string() })).default([]),  // files the agents should read first
  workspace: z.object({
    mode: z.enum(['worktree', 'current-checkout']).default('worktree'),
    baseRef: z.string().optional(),                 // default: current branch
    branch: z.string().optional(),                  // default: ensemble/<slug>
    setupCommands: z.array(z.string()).default([]), // e.g. "npm ci"
    copyFiles: z.array(z.string()).default([]),     // untracked files to copy: ".env", "appsettings.Development.json"
  }),
  agents: z.array(EnsembleAgent).min(1).max(12),
  pipeline: z.array(Stage).min(1).max(30),
  limits: z.object({
    maxCostUsd: z.number().positive().optional(),
    maxDurationMin: z.number().int().positive().optional(),
    maxConcurrentAgents: z.number().int().min(1).max(8).default(3),
  }),
  createdAt: z.number(), updatedAt: z.number(),
  templateId: z.string().optional(),
});
```

**Run state** (`EnsembleRun`, persisted after every conductor event): `status` (`draft` · `preparing` · `running` ·
`paused` · `needs-you` · `done` · `failed` · `stopped` · `interrupted`), `stageStates[]` (`pending` · `running` ·
`waiting-gate` · `done` · `failed` · `skipped`, round counter for loops, attempts for commands), per agent
`sessions[]` (`terminalId`, `cliSessionId`, `roleToken` (in memory only), `state`, `startedAt`, `lastProgress`,
`tokens`, `costUsd`), `handoffs[]` (outputs of `oxy_ensemble_submit`), `questions[]`, `notes[]`, `events[]`
(timeline, capped, older events moved to the artifacts folder), `worktree` (`path`, `branch`, `baseCommit`),
`checkpoints[]` (`stageId`, `commit`), totals.

**Storage:** `<userData>/ensemble/tasks/<taskId>.json` (task + run) and `<userData>/ensemble/tasks/<taskId>/`
(artifacts: `plan.md`, `review-<round>.md`, `test-report-<n>.md`, prompt files, `events.jsonl`). Templates in
`<userData>/ensemble/templates.json`; repository-shared templates in `.oxytocin/ensemble/*.json` (step 7, with the
same "use this file?" trust prompt as `.oxytocin/project.json`).

### Pipeline model

A pipeline is an ordered list of stages. That is deliberately simpler than a graph and still covers the useful
shapes:

| Stage kind | Meaning | Typical use |
|---|---|---|
| `agent` | One agent does the instruction and submits an output of the stage's kind | Plan, implement, research, write docs |
| `parallel` | Several agents get the same instruction (or one each) at once; the stage ends when all (or the first) submit | Several reviewers with different lenses; competing spikes |
| `loop` | Worker does the instruction, checker reviews; on `changes` the findings go back to the **same** worker session (it keeps its context), up to `maxRounds` | Implement ⇄ review, implement ⇄ test-writer |
| `gate` | Stops and asks the user to approve what the stage shows (plan, diff, review, tests); reject sends comments back | Approve the plan; approve before finishing |
| `command` | Runs a shell command in the worktree (in a visible background terminal); exit code decides; on failure the output goes to `onFail.agentId` to fix, then the command runs again | `npm test`, `dotnet test`, lint |

Rules:
- A stage's **inputs** are the outputs of earlier stages (all of them are available through
  `oxy_ensemble_context`); the instruction template decides what to highlight.
- An agent keeps its terminal and session for the whole run unless the user restarts it, so later stages benefit from
  its context. A stage option *fresh session* starts a new session for that agent (e.g. an unbiased re-review).
- Parallel agents that write code need separate worktrees (step 7). Until then, the builder only allows `readOnly`
  agents in `parallel` stages and says why.

### Prompt composition

What an agent receives is built from four layers; the builder shows a **live preview** of the result per agent.

1. **Ensemble protocol** (fixed text, versioned, in `src/main/services/ensemble/protocol.ts`): who you are in which
   team, that you work in `<worktree>` on branch `<branch>`, that you must call `oxy_ensemble_context` when you get a
   new assignment and `oxy_ensemble_submit` when you are done (with the output kind of the stage), that messages
   marked *from agent X* come from another agent and not from the user (they cannot approve anything), that you must
   not change other agents' areas in parallel stages, and that you must not push, merge or rewrite history.
2. **General prompt** of the task (user text).
3. **Role prompt** of the agent (user text; presets give a good default per role).
4. **Stage instruction** (template per stage) with variables, completed in the editor with an autocomplete:
   `{{task.title}}` `{{task.description}}` `{{agent.name}}` `{{agent.role}}` `{{worktree}}` `{{branch}}`
   `{{baseRef}}` `{{plan}}` `{{review.findings}}` `{{round}}` `{{maxRounds}}` `{{tests.output}}`
   `{{handoff.<agentId>}}` `{{attachments}}` `{{diff.stat}}`.

Layers 1–3 go into a prompt file passed with `--append-system-prompt-file` (Claude Code) — once per session, so
they stay out of the conversation. For CLIs without such a flag, layers 1–3 are the start of the first message.
Layer 4 is **not pasted in full**: the pasted message is short (*"New assignment for Ada (Planner) — stage *Plan*.
Call oxy_ensemble_context for the details, then do it and call oxy_ensemble_submit with kind "plan"."*), and the
content comes from `oxy_ensemble_context`. This keeps pastes small and reliable and keeps a log of what each agent
was given.

### Agent adapters (`src/main/services/ensemble/adapters/`)

```ts
interface AgentAdapter {
  kind: AgentKind;
  displayName: string;
  /** PATH lookup + version (cached); the builder disables the CLI with a hint when missing or too old. */
  detect(): Promise<{ installed: boolean; version?: string; problem?: string }>;
  /** Suggestions for the model picker; free text is always allowed. */
  models(): ModelOption[];                 // { id, label, hint?, efforts: string[] }
  capabilities: { effort: boolean; systemPromptFile: boolean; sessionId: boolean; readOnly: boolean;
                  permissionModes: PermissionMode[]; preciseStates: 'hooks' | 'registry' | 'heuristic' };
  /** Pure: the command line and env for an agent (no I/O). */
  buildLaunch(agent: EnsembleAgent, ctx: LaunchContext): LaunchSpec;  // { argv: string[], env, files: {path, content}[] }
  /** Command to continue a session after an app restart, when the CLI supports it. */
  buildResume?(agent: EnsembleAgent, ctx: LaunchContext, cliSessionId: string): LaunchSpec;
}
```

**Claude Code** (the reference adapter, step 1):
`claude --model <model> --effort <effort> --name "ens:<task-slug>/<agent-name>" --session-id <uuid>
--append-system-prompt-file <artifacts>/<agentId>.prompt.md --permission-mode <mode>` plus, for `readOnly`,
`--disallowedTools Edit Write NotebookEdit` and, when Oxytocin's MCP server is not registered in Claude Code,
`--mcp-config '<inline json>'` (see [Identity of the calling agent](#identity-of-the-calling-agent)). Model options:
the aliases `opus`, `sonnet`, `haiku`, `fable`, `best`, `opus[1m]`, `sonnet[1m]` plus free text; efforts `low`,
`medium`, `high`, `xhigh`, `max` (filter by model where known; `max` and `xhigh` are not available on every model —
show the CLI's error if it rejects a level). Check the minimum Claude Code version that supports `--effort` with
these levels and record it.

The `argv` is turned into the terminal's `initialCommand` with **shell-specific quoting** (PowerShell, cmd, bash/zsh,
fish — move the quoting helper from `src/renderer/src/features/terminals/path-quoting.ts` into `src/shared/utils/`
and extend it). Long texts never go on the command line: they go into files in the artifacts folder.

### Isolation (the owner's requirement)

What Ensemble guarantees, and how each point is tested:

| Guarantee | How | Test |
|---|---|---|
| The user's default model and effort are unchanged | Only `--model`/`--effort` flags; Ensemble never types `/model` or `/effort` (the paste builder rejects text starting with `/`) | Unit: no slash command can be produced. E2E: fake `CLAUDE_CONFIG_DIR/settings.json` is byte-identical after a run |
| No settings file is written | Per-session overrides via `--settings` inline JSON only; no writes to `~/.claude*`, `~/.codex`, `~/.gemini` | E2E: config dirs' file hashes unchanged |
| The user's checkout is untouched | Worktree mode by default; *current checkout* needs an explicit choice with a warning | E2E: main checkout `git status` clean after a run |
| Environment does not leak | Agent `env` applies to its terminal only (`CreateTerminalRequest.env`) | Unit: env composer |
| Sessions are recognisable | Session names `ens:<task>/<agent>` appear as such in `claude --resume` | Manual check, recorded |

Note for the UI: sessions of Ensemble still show up in Claude Code's `/resume` list and still count against the
account's usage limits. Say so in the builder's footer, not as a blocker.

### Identity of the calling agent

The `X-Oxytocin-Terminal` header is a hint, not a security boundary (`caller-context.ts`). Ensemble needs to know
reliably which agent calls `oxy_ensemble_submit`:

- Every Ensemble terminal gets a random **role token** in its env (`OXYTOCIN_ENSEMBLE_TOKEN`), kept in memory in main
  only (never persisted, never shown).
- The Claude Code registration (`client-registration.ts`) gains a second header,
  `X-Oxytocin-Ensemble: ${OXYTOCIN_ENSEMBLE_TOKEN:-none}`, next to the terminal header. Existing registrations are
  updated the same way plugin changes are (verify that re-registering keeps working without reconnect prompts).
- `oxy_ensemble_*` tools resolve the agent from the token; a call without a valid token gets a clear error
  (*"This terminal is not part of an Ensemble task"*). The terminal id must match the token's terminal.
- When Oxytocin is not registered in Claude Code at all, the adapter passes `--mcp-config` with an inline server entry
  named `oxytocin` and both headers. **Verify** what Claude Code does when the same server name exists in user config
  and in `--mcp-config` (record it); if it duplicates tools, use the name `oxytocin-ensemble` with only the ensemble
  tools exposed through a path or query parameter of the same HTTP server.
- Other CLIs: pass headers through their MCP config mechanism (Codex `-c mcp_servers.…`; verify) or, if a CLI
  cannot send headers, put the token into the context tool's arguments **only for that adapter** (documented in the
  protocol text for it).
- The hub lists tools globally (not per session): hide the `oxy_ensemble_*` tools while no run is active
  (`setCoreHidden`, like resource tools) and make them reject non-members.

### Ensemble tools (core tools in the MCP hub)

| Tool | Purpose |
|---|---|
| `oxy_ensemble_context()` | Who am I (agent, role, stage, round), the task brief, general prompt, my current instruction with variables resolved, the inputs (plan, findings, test output, other agents' handoffs), worktree and branch, the team list, notes on the board, open questions addressed to me. Markdown text + `structuredContent`. |
| `oxy_ensemble_submit({ kind, summary, body?, verdict?, findings?, files? })` | Finishes my part of the stage. `kind` must match the stage's output kind. `review` requires `verdict: approve \| changes` and `findings[]` (`file`, `line?`, `severity`, `message`). Returns what happens next (*"Handed to Grace for review"*). Validated with zod; a wrong kind gets a helpful error, not a silent accept. |
| `oxy_ensemble_progress({ message, percent? })` | One-line status shown on the agent's card ("Writing tests for CsvExporter"). Cheap, rate-limited. |
| `oxy_ensemble_ask({ to, question, blocking? })` | Ask another agent (by name) or `user`. To an agent: delivered when it is idle, as a message marked *from <name>*. Blocking (default) waits up to 10 minutes for the answer, else returns *"no answer yet — continue, the answer will be delivered to you"*. To `user`: appears in the Ensemble inbox and as a notification. |
| `oxy_ensemble_answer({ questionId, answer })` | Answer a question addressed to me. |
| `oxy_ensemble_note({ text })` | Post a note on the task's board (decisions, gotchas), visible to all agents via the context tool and in the Activity view. |

Policies: all are *Run without asking* by default (they act only inside the task); they appear in Settings → Agent
Tools like other core tools, with the call log.

### Conductor and prompt delivery

**Delivery (`PromptDelivery`)** — the most fragile part; keep it small, explicit and well tested.

1. Wait until the agent is `idle` (from `AgentService`; with Claude Code Bridge hooks this is exact). Never type while
   it is `waiting` (a permission or trust dialog would receive the text) or `working`.
2. Paste through a new PTY Host RPC `paste({ id, text, submit })`: the PTY Host knows from the headless mirror
   whether bracketed paste is on; it wraps the text (`\x1b[200~ … \x1b[201~`) when it is, then sends `\r` when
   `submit` is set. Never paste text starting with `/` (slash commands).
3. Confirm: the agent must turn `working` within ~10 s (hook `UserPromptSubmit` for Claude). If not, retry once; then
   mark the agent *needs you* ("The agent did not start — open its terminal").

**Completion:** a stage part is done when the agent calls `oxy_ensemble_submit`. If an agent goes idle without
submitting, the conductor waits 20 s (it may still call the tool), then delivers one reminder (*"You stopped without
calling oxy_ensemble_submit…"*); after a second idle without submit, the agent is marked *needs you* and the run waits.
The user can also **Mark as done** with a summary they type.

**Pause / Stop / Take over:** *Pause* lets running turns finish and delivers nothing new. *Stop* kills every agent of
the task (graceful, then force after 3 s, like `terminals.kill`) and keeps the worktree. *Take over* on an agent: the
user types in its terminal; the conductor does not deliver to that agent until the user clicks *Hand back*.

**Agent start-up:** the first start of `claude` in a new worktree may show the folder trust dialog. **Verify** whether
a worktree of an already trusted repository is trusted; if not, the run shows *needs you: confirm the folder in Ada's
terminal* with a button that opens the terminal (do not write to `~/.claude.json` — isolation).

**Limits:** before each delivery check `maxCostUsd`, `maxDurationMin` and the Claude subscription limits (from the
Usage Monitor, step 6). Over a limit → pause with a clear reason and *Continue anyway*.

**After an app restart:** runs that were `running` become `interrupted`. *Resume* restarts each agent with
`--resume <cliSessionId>` (Claude Code; other CLIs start fresh with a summary of their earlier handoffs) and repeats
the current stage's delivery. Never resume automatically.

### Workspace (worktrees)

- New Workspace Host RPCs: `worktree.add({ repoRoot, path, branch, baseRef })`, `worktree.remove({ path, force })`,
  `worktree.list`, `git.commitAll({ cwd, message })` (checkpoints), `git.diffStat({ cwd, base })`,
  `status({ root })` for an arbitrary root. These write, so they cannot use `--no-optional-locks` semantics for the
  write itself — keep status reads with `--no-optional-locks` and serialize writes per repository.
- Location: setting `ensemble.worktreeRoot`, default `<userData>/ensemble/worktrees/<project-slug>/<task-slug>`
  (outside the repository: nothing to ignore, no editor watchers on it). Show the path with *Open folder* / *Open in
  editor*.
- *Prepare workspace* (a visible stage `preparing`): create the worktree, copy `copyFiles` (only untracked files,
  only within the repository), run `setupCommands` in a visible background terminal; failure stops with the output.
- **Checkpoints:** after every finished stage that changed files, commit in the worktree
  (`ensemble: <stage title> (<agent>)`, author = the user's git identity). This gives a diff per stage, *Rewind to
  this stage* (reset the worktree to a checkpoint after a confirmation) and a clean history to squash at the end.
- **Finish** (last step of every run, a dialog): *Merge into `<base>`* (only if the user's checkout is clean and on
  that branch; otherwise explain and offer the next option), *Keep branch* (leave the branch, remove the worktree),
  *Squash into one commit* (option for both), *Discard* (remove worktree and branch after a confirmation),
  *Copy summary* (a Markdown report usable as a PR description).

### UI and UX

Visual quality matters as much as function. Use only CSS tokens (`tokens.css`); add tokens for role colors if needed.
Respect `prefers-reduced-motion`. Everything works with the keyboard. Dark and light themes.

**Entry points**
- "+" menu of a workspace group → **Tools → Ensemble** (icon `Workflow` from lucide), also **Add tool** of the
  sidebars (a compact task list variant, see below). One Ensemble panel per workspace (re-activated, like the
  scratchpad).
- Command palette: *Ensemble: Open*, *Ensemble: New Task*, *Ensemble: New Task from Selection* (scratchpad text or a
  terminal selection becomes the description).
- Status bar item when something runs: `◉ Ensemble 1 running · 1 needs you`; click opens the panel.
- Attention: a task that needs the user counts in the attention badge; `Ctrl+Shift+J` jumps to it.

**Panel layout**

```
┌ Tasks ──────────┐┌ CSV export for reports ───────────────── ● Running  02:14  $1.84 / $10 ▮▮▮▯▯  ⏸  ■ ┐
│ ● Needs you (1) ││ ensemble/csv-export  ·  worktree ↗  ·  base main @ 4f2a91c                              │
│   CSV export    ││ [Pipeline] [Agents] [Activity] [Changes] [Artifacts] [Task]                            │
│ ◉ Running (1)   ││                                                                                        │
│   Auth refactor ││  ┌ Plan ─────┐   ┌ Approve ┐   ┌ Implement ⇄ Review ────────┐   ┌ Tests ┐   ┌ Finish ┐ │
│ ○ Drafts (2)    ││  │ (A) Ada   │──▶│  ✓ you  │──▶│ (L) Linus ⟲ round 2/3 (G)  │──▶│  npm  │──▶│   ⎇    │ │
│ ✓ Done (5)      ││  │ Opus·xhigh│   └─────────┘   │ ● working   "Fixing CSV…" │   │ test  │   └────────┘ │
│                 ││  │ ✓ done    │                 │ Grace: 3 findings → fixing │   └───────┘              │
│ [+ New task]    ││  └───────────┘                 └────────────────────────────┘                          │
│                 ││  ─────────────────────────────────────────────────────────────────────────────────────  │
│ Templates ▸     ││  Linus · Implementer · Opus medium · ● working 01:12 · 38% context · $0.91   [Peek ▸]  │
└─────────────────┘└────────────────────────────────────────────────────────────────────────────────────────┘
```

- Left: **task list** grouped *Needs you · Running · Drafts · Done*, each with a mini pipeline progress bar. New task
  button and templates. Collapsible.
- Header: title (editable in drafts), status pill, elapsed time, cost with budget meter, controls (*Start*, *Pause*,
  *Resume*, *Stop*), branch and worktree chips.
- Tabs: **Pipeline** (default while running), **Agents**, **Activity**, **Changes**, **Artifacts**, **Task** (the
  builder; read-only parts while running).

**Builder (draft tasks) — one page, no wizard**

- Top: *Start from template* cards (Feature: plan → implement ⇄ review → tests; Bugfix: reproduce with a failing
  test → fix ⇄ review; Review only; Research spike; Refactor with tests; Second opinion across vendors; Blank).
- Section **Brief:** title, description (Markdown editor like the scratchpad, drop files → attachments as paths),
  general prompt (collapsible, with an example placeholder), workspace mode (worktree / current checkout), base
  branch, setup commands, files to copy (suggests `.env*`, `appsettings.Development.json`, … found untracked).
- Section **Team:** agent cards in a responsive grid. Each card: avatar (initial in the role color), editable name,
  role chip (preset + label + color), CLI picker with logos (missing CLIs disabled with *Install …* hint and version
  check), **model** combobox (suggestions + free text), **effort** as a segmented control
  (`low · medium · high · xhigh · max`, unavailable levels disabled with a tooltip), permission mode, *Read-only*
  switch, role prompt editor (expandable, variable autocomplete, *Use preset text*), advanced (extra args, env) behind
  a disclosure. Card menu: *Duplicate*, *Save as preset*, *Remove*. *Add agent* opens a quick picker of role presets
  ("Planner — Claude Code · Opus · xhigh", …) that pre-fill everything.
- Section **Pipeline:** a horizontal lane of stage cards; drag to reorder; *Add stage* menu (Agent step, Parallel,
  Implement ⇄ Review loop, Approval gate, Command); drag agent avatars from the team onto stages; per stage: title,
  instruction template with variables, output kind, loop rounds, gate content, command and on-fail agent. Invalid
  configurations are marked inline (e.g. a parallel stage with writing agents before step 7).
- Right rail (sticky): **Prompt preview** for the selected agent (all four layers, with the variables of a sample
  run), **checks** (CLIs installed, Bridge hooks installed for exact states — with *Install*, Oxytocin connected in
  Claude Code — with *Connect*, git repository clean enough for a worktree) and an **estimate** (agents × stages, a
  rough cost range from the Usage Monitor's prices, *"3 Claude sessions on the same account share your 5-hour limit
  (now 42% used)"*).
- Footer: *Save draft*, *Save as template*, **Start** (`Ctrl+Enter`).

**Pipeline view (running)**

- Stage cards connected by edges; the active edge shows a subtle flowing animation during a handoff. Status rings:
  pending (muted), running (accent, pulsing), needs you (warning), done (success check), failed (danger).
- Loop stages draw a cycle with *round 2/3* and the latest verdict; parallel stages stack their agents.
- Agent chips inside stages: avatar, role, `Model · effort` badge, live state dot (working / idle / waiting / done),
  last progress line (from `oxy_ensemble_progress`, else the last tool activity from the Bridge's `PostToolUse`, e.g.
  *Editing src/export/csv.ts*), tokens, cost, context-window ring (from the Claude transcript, when available).
- **Peek:** hovering an agent shows a live thumbnail of its terminal; clicking opens a **side drawer with the real
  terminal** (`TerminalView` attached to the background terminal: full scrollback, typing = take over), with
  *Open as tab*, *Pop out* (floating group), *Restart agent*, *Send message*.
- Bottom strip: the selected agent's details and its recent timeline.

**Agents tab — the wall:** a grid of all agents' live terminals (read-only previews, rendering throttled for
off-screen and unfocused tiles), each with its header (role, model, state, cost). Click a tile to focus it. This is
the "watch everything" view.

**Activity tab:** timeline of the run — stage starts/ends, handoffs (expandable, Markdown rendered: the plan, review
findings with file links that open the preview at the line), questions and answers, notes, gate decisions,
reminders, limits hit, errors. Filter by agent and type; search.

**Changes tab:** files changed in the worktree vs. the base (reuse the Changes tree and the Monaco diff), with a
selector *whole task · per stage (checkpoint)*; *Open worktree in editor*.

**Artifacts tab:** plan, reviews, test reports, the final summary; *Open in preview*, *Copy*.

**Needs you:** a prominent banner in the task and an inbox popover in the panel header listing everything waiting for
the user — gate approvals, questions from agents (answer inline), agents waiting on a permission prompt (*Answer in
terminal* opens the drawer), stuck agents, limits. OS notifications for the same (only when the window is not
focused, reusing the notification service) and for *task done* / *task failed*.

**Gate dialog:** rendered plan (or diff / review / test report) with line-anchored comments; *Approve*, *Request
changes* (comments go back to the stage's agent as the next instruction), *Edit and approve* (edit the plan text
directly), *Stop task*.

**Keyboard:** `N` new task (in the panel), `Ctrl+Enter` start, `J`/`K` next/previous agent, `Enter` peek, `Esc`
close drawer, `P` pause/resume, `A` approve the open gate. Add them to the keybindings registry (editable).

**Empty state:** a short explanation with an illustration of a three-stage pipeline, the template cards and
*Create your first task*.

### More features worth having (prioritized into the steps below)

- **Templates** — built-in, user, and shared in the repository (`.oxytocin/ensemble/*.json`).
- **Role presets** — reusable agent definitions ("Security reviewer — Sonnet high, read-only, prompt …").
- **Cost and limits** — per-agent and per-task cost (Usage Monitor), budget, estimate before start, the shared
  5-hour/weekly limit warning, a concurrency limit and a queue for tasks that cannot start yet.
- **Context meter** — percentage of the context window used per Claude agent; warning near auto-compaction.
- **Checkpoints and rewind** — commit per stage, diff per stage, rewind.
- **Cross-vendor second opinion** — the *Second opinion* template: Codex or Gemini reviews Claude's work.
- **Competing implementations** — N implementers in separate worktrees, then a judge agent or the user picks one.
- **Report** — Markdown summary (brief, plan, rounds, findings fixed, tests, cost, time) for a PR description.
- **Send message** — the user writes to one agent or broadcasts to all from the panel.
- **Task from elsewhere** — from the scratchpad selection or a terminal selection; later from GitHub issues.
- **Agent-created tasks** — an MCP tool `oxy_ensemble_create_task` (ask-first) so an interactive agent can propose a
  task with a team; the user reviews it in the builder before it starts. (Later.)
- **Headless helper steps** — `claude -p --output-format json` for cheap, short steps (e.g. summarizing a diff)
  without a terminal. (Later.)

## Pitfalls

- **Typing into a TUI is fragile.** Only at `idle`, never at `waiting`; keep pastes short; content through the MCP
  context tool; confirm the agent started; never send slash commands.
- **Precise states need the Claude Code Bridge hooks.** Without them, idle detection relies on the registry and output
  heuristics and is slower; the builder recommends installing the hooks and the conductor uses longer grace periods.
- **Folder trust dialog** on the first start in a new worktree (verify; see Conductor).
- **Effort levels depend on the model and the CLI version.** Check `claude --version` once per run; show the CLI's
  own error if a level is rejected.
- **Shared usage limits.** Three Opus/Sonnet sessions on one subscription drain the 5-hour limit fast — make it
  visible before and during the run.
- **Windows (primary platform):** PowerShell/cmd quoting of the command line, long paths for worktrees under
  `userData` (keep slugs short; check `core.longpaths`), ConPTY + bracketed paste (verify with Claude Code and Codex
  on Windows), file locks while removing a worktree (retry, then explain).
- **git:** worktree add/remove and checkpoint commits write and take locks — serialize them per repository; keep all
  status reads `--no-optional-locks`; read HEAD content with `git cat-file --filters`.
- **Agents that ignore the protocol** (no submit) — reminder, then *needs you*, *Mark as done*.
- **Messages between agents** must say they come from an agent, not the user, so no agent treats them as approval.
- **Performance:** several background terminals with headless mirrors are fine; throttle rendering of wall tiles and
  thumbnails (only render visible tiles; snapshot thumbnails at most every 500 ms).
- **Persistence:** write the run after every conductor event (debounced, atomic); never lose a handoff on quit.
- **Do not depend on undocumented Claude Code files** for anything essential (the session registry is already
  parsed tolerantly; keep it that way).

## Implementation steps

Each step: code + tests, `npm run check` green, relevant E2E green (`xvfb-run -a npm run e2e` on Linux), changelog
entry for user-visible changes, commit on `main` (Conventional Commits, authored as the owner, no trailers), push.

1. **Ensemble tool with a sequential pipeline of Claude Code agents.** Domain model and store; the pure conductor
   with `agent` stages; Claude Code adapter and launch composer with the isolation rules; role tokens and the second
   MCP header; `oxy_ensemble_context`, `oxy_ensemble_submit`, `oxy_ensemble_progress`; PTY Host `paste` RPC and
   `PromptDelivery`; the panel in the "+" menu with the task list, builder (brief, general prompt, team cards with
   model/effort/permission/read-only/role prompt, sequential stages, prompt preview, checks) and the pipeline view
   with live states and the peek drawer; *current checkout* workspace mode only, with its warning; pause/stop/take
   over; `interrupted` + *Resume* after a restart. E2E with a fake Claude Code that logs its argv, calls the MCP tools
   and writes registry states: create a two-agent task, start it, both stages finish in order, the second agent got
   the first one's output, argv contains `--model`/`--effort`, the fake `settings.json` is unchanged.
2. **Worktrees and finishing.** Workspace Host RPCs; worktree mode (default); prepare stage with setup commands and
   copied files; checkpoints; Changes tab (whole task / per stage); finish dialog (merge / keep / squash / discard /
   copy summary). E2E against a temporary repository.
3. **Loops, gates, commands and the inbox.** `loop`, `gate`, `command` stages; gate dialog with comments; *Needs you*
   inbox, status bar item, attention badge, OS notifications; *Mark as done*; reminders. E2E: a review loop that
   needs two rounds, a gate approval, a failing then passing command.
4. **Agents talk to each other.** `oxy_ensemble_ask`, `oxy_ensemble_answer`, `oxy_ensemble_note`; *Send message*;
   the Activity tab with the full timeline; the Markdown report. E2E: the fake reviewer asks the fake planner a
   question and the answer reaches it.
5. **Other CLIs.** Codex CLI, Gemini CLI, OpenCode and *custom command* adapters after verifying their flags,
   MCP header support and paste behaviour (verification log); the *Second opinion* template.
6. **Cost, limits and the wall.** A Usage Monitor command (e.g. `usage.sessionTotals(sessionIds)`) called from main;
   cost per agent and task, budget, estimate, limit warnings, concurrency limit and task queue, context meter; the
   Agents wall.
7. **Templates and parallel work.** Built-in, user and repository templates (with the trust prompt), role presets;
   `parallel` stages with a worktree per writing agent and merging of their branches into the task branch; the
   *Competing implementations* template with a judge stage.
8. **Wrap up.** README section and screenshots (`npm run screenshots`), docs for the protocol text, performance check
   with 6 agents, Windows verification, and after the release that contains the feature, rename this file to
   `03-released-…` (or delete it).

## Testing

- **Unit (`unit-node`):** conductor reducer (every stage kind, loops, max rounds, gates, failures, pause/stop,
  restart → interrupted → resume), prompt composition and variables, adapters' `buildLaunch` for each CLI and each
  shell (quoting snapshots for PowerShell, cmd, bash, fish), the slash-command guard, schemas round-trip with unknown
  fields, role-token checks in the tools, delivery logic against a fake agent state stream (never at `waiting`,
  retry, reminder).
- **Unit (`unit-web`):** builder validation, pipeline view states, keyboard handling.
- **Integration:** `EnsembleService` with a fake PTY Host and a fake MCP caller; Workspace Host worktree RPCs against
  a temporary repository.
- **E2E:** extend the fake Claude Code fixture into a scriptable fake agent: logs argv to a file, renders a prompt,
  reads pasted input (bracketed), reports states through the registry, and on each assignment calls
  `oxy_ensemble_context` and `oxy_ensemble_submit` over HTTP with the headers from its env (behaviour per agent from
  a script file named in its env, e.g. "reviewer: request changes in round 1, approve in round 2"). Tests per step as
  listed above, plus the isolation checks.

## Definition of done

- Ensemble opens from the "+" menu; a task with several Claude Code agents with different models and efforts runs
  through plan → gate → implement ⇄ review → tests → finish in its own worktree, visible live, every agent can be
  peeked at and taken over, and the user's default model, effort, settings and checkout are unchanged afterwards.
- Codex CLI (at least) works as an agent in the same pipeline.
- Agents can ask each other and the user questions; gates and the inbox work; costs and limits are visible.
- Tests as listed; `npm run check` green; README and changelog updated.

## Verification log

Fill in while implementing.

- Minimum Claude Code version for `--effort` with `xhigh`/`max`, and which models accept which levels: *(open)*
- Claude Code behaviour when the MCP server name in `--mcp-config` equals a user-scope server: *(open)*
- Header env interpolation for `X-Oxytocin-Ensemble` works like `X-Oxytocin-Terminal`: *(open)*
- Folder trust dialog in a new worktree of a trusted repository: *(open)*
- Bracketed paste + `\r` submits a prompt in Claude Code on Windows (ConPTY), macOS, Linux: *(open)*
- Codex CLI: model, reasoning effort, read-only sandbox, MCP headers, paste/submit, session resume: *(open)*
- Gemini CLI and OpenCode: same list: *(open)*
- `claude --resume <id>` restores an Ensemble agent after an app restart with its prompt file still applied: *(open)*

## References

- Claude Code — Model configuration (model/effort, precedence, `/model` Enter vs `s`):
  https://code.claude.com/docs/en/model-config
- Claude Code — CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code — Agent teams: https://code.claude.com/docs/en/agent-teams
- Claude Code — Cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- Claude Code — Channels reference: https://code.claude.com/docs/en/channels-reference
- Overview of open-source agent orchestrators: https://www.augmentcode.com/tools/open-source-agent-orchestrators
- The Code Agent Orchestra (Addy Osmani): https://addyosmani.com/blog/code-agent-orchestra/
