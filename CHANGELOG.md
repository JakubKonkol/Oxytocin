# Changelog

All notable changes to Oxytocin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/) (0.x until the plugin API is stable).

## [Unreleased]

### Added

- **Usage Monitor:** the Sessions table has a "Code Map" column: how many Code Map tool calls the agent in that
  terminal made during the session and how many characters of answers it received; the tooltip adds stale, not-OK and
  failed answers. Oxytocin keeps only counts, in memory since the app started — no queries, paths or code.

- **Code Map:** a project can turn on *Suggest code locations with each prompt* (Project settings → Code Map, off by
  default). With the Claude Code Bridge installed, Oxytocin then adds up to three file pointers to Claude Code's context
  when a prompt matches the map strongly, and nothing otherwise; pointers already given in the session are not repeated.
  The prompt is read locally for that one lookup and is never stored or logged.

### Changed

- **Code Map:** agent answers are much cheaper to use.
  - Agents see one tool to locate code (`oxy_find_code`; `oxy_task_context` while Review memory is on) and no status
    tool; the tool schemas and the guidance are about 60% smaller and say when plain Grep is the better choice.
  - Answers are quiet `path:lines kind signature` pointers, about 55% shorter: no header, coverage totals or symbol
    IDs. One line appears only when the index is updating or a cited file changed, and "Truncated" only when the size
    budget cut results.
  - `oxy_code_relations` accepts `path` and `line`, so a pointer from a find answer can be used directly.
  - While files are re-indexed, queries answer from the last published map, marked as stale, instead of returning
    "updating" without data.
  - The `CLAUDE.md`/`AGENTS.md` instruction block is a single line; existing opted-in blocks are upgraded
    automatically.
- **Code Map:** finding code is more accurate. `oxy_find_code` and the task context now rank on what is inside function
  bodies (BM25F over names, paths and bodies with query coverage), rank tests and docs lower unless the question asks
  for them, and show one result per file first; results carry `coverage` and `strong` confidence fields. On Oxytocin's
  own questions the right file comes first in 27 of 44 cases instead of 19. The map cache grows by about 40% and is
  rebuilt once after the update; `graph.json` is unchanged.
- **Code Map:** TypeScript and JavaScript method calls on values with a declared type are resolved (constructor
  parameter properties, fields, parameters, `new T()`, return types, inherited members), so `oxy_code_relations` finds
  about a quarter more callers; path aliases such as `@shared/*` resolve through a solution-style `tsconfig.json` with
  project references instead of appearing as external packages.

## [0.9.13] - 2026-10-23

### Changed

- **Task:** reworked so that planner → approval → implementer works without manual hand-offs.
  - A Claude planner hands its finished plan to Task and **waits for your decision** in its plan hook: Approve ends its
    turn, Revise sends your feedback as its answer (Claude revises at once, nothing is typed into its terminal), Reject
    ends the task. Press Esc in its terminal to talk to it instead.
  - Every role starts in a **new session with a clean context** unless you choose a running one; the implicit reuse
    of a matching session is gone. New sessions start with their prompt on the command line, so "the agent is not
    ready" no longer happens.
  - A prompt for a session that already runs is typed as soon as its agent waits for input, never over a turn or a
    question; Task shows what it waits for instead of an error, and there is nothing to retry.
  - The implementer and the reviewer read a brief (the task and the approved plan) from Task's folder, so the plan
    keeps its formatting on Windows too.
- **AI agents:** a new Claude Code, Codex CLI, Gemini CLI or Qwen Code session started by Oxytocin with a prompt (Task,
  Changes → Send to review, plugins) receives it on its command line instead of having it typed once the agent is
  ready (Plugin API 0.2.2, which also adds `addDirs`).

### Fixed

- **Sidebars:** a section collapsed, moved or resized right before quitting is remembered.
- **Tests:** E2E tests no longer depend on the machine they run on: the app window has the same size on every screen,
  terminals are typed into once their prompt is shown, AI agent variables of the test runner's environment (an API
  base URL, a surrounding Claude Code session) are not passed on, and latency budgets fail only on a gross
  regression (measurements are still recorded in `perf-results.json`). CI runs E2E next to the other checks in three
  shards per platform and records traces only for retried tests, which shortens a release run considerably.

## [0.9.12] - 2026-10-21

### Fixed

- **Code Map retrieval:** focused lookups return compact source pointers with better identifier and configuration ranking.
  Task context defaults to six matches and adds a small neighborhood only when needed. Full JSON remains available
  with `format: "json"`. Smaller maps and refreshed generated instructions avoid mandatory broad context for simple questions.
- **Code Map Visualizer:** a force layout, quieter edges, neighborhood highlighting and a directional connection inspector
  make dependencies easier to read. The graph has more space; the accessible outline and additional filters open on demand.

## [0.9.11] - 2026-10-20

### Added

- **Code Map Visualizer:** Knowledge shows findings next to their code and evidence, with review and freshness filters.
  Task context shows the items an agent received and why, using an expiring receipt. Both require the new
  `code-map.knowledge.read` permission (Plugin API 0.2.1); the core Learnings manager remains available separately.
  An offline longitudinal corpus and evaluation harness cover four arms and changed evidence. Automatic remains
  unavailable until measured evaluation passes its release gate.

- **Code Map learnings for agents:** `oxy_task_context` returns bounded code pointers, relations and up to three
  applicable reviewed findings. Agents propose reusable findings with `oxy_propose_learning` and report feedback
  with `oxy_learning_feedback`. Receipts bind feedback to the authenticated session and checkout; negative feedback
  suspends reuse until review. Review mode remains the default.
- **Code Map learnings:** a core settings manager for user findings in main and Ensemble checkouts, with evidence hashes,
  review, revision history, search, export and confirmed deletion. Changed evidence requires explicit revalidation;
  rebuilding or deleting the map preserves findings. Removed worktrees retain an inspectable archive; explicitly
  promote a finding to share it with the project. Project budgets include live stores, archives and revisions.
  Memory settings offer Review and Off;
  Automatic is unavailable.
- **Code Map:** Python support — package roots, declarations, decorators, relative imports/re-exports and simple
  calls, including self methods. Unknown instance attributes and dynamic imports remain unresolved; support is shown
  as Imports with simple calls.
- **Code Map:** Java support — packages and source modules, declarations, imports, inheritance and calls bound from
  declared receiver types and argument counts. Reflection and ambiguous same-arity overloads remain unresolved.
- **Code Map:** Go support — modules and workspace packages, declarations, imports and calls resolved from declared
  receiver types. Interface dispatch and unknown receivers remain unresolved; build tags are recorded, not evaluated.
- **Code Map Visualizer:** Changes highlights uncommitted files and their potential indexed dependents. Impact
  follows incoming dependencies up to three steps. Switch between the main folder and Ensemble worktrees; task
  changes compare with their recorded base, including committed edits.
- **Code Map Visualizer:** explore folders, file dependencies and symbol neighborhoods, search the index and open
  verified source locations. Filter relations and evidence, keep node positions across updates, or use the keyboard
  through a list. Available from the project menu, Code Map settings and the Add menu; all assets work offline.
- **Plugin API 0.2.0:** `oxy.codeMap` (`code-map.read`) lists checkouts, reports status, serves bounded graph slices,
  search, outlines and relations, delivers invalidations and opens verified source locations, including worktrees.
  Plugins that declare `engine: "^0.1.x"` need an update to `^0.2.0` before they load again.
- **Code Map:** Ensemble worktrees get separate maps and authenticated agents query their own checkout. Add or remove
  the agent guidance in `CLAUDE.md` or `AGENTS.md` from Code Map settings. Ensemble diffs and checkpoint commits exclude
  `.oxy` data, including files already tracked by a worktree's base commit.
- **Code Map for agents:** `oxy_find_code`, `oxy_file_outline`, `oxy_code_relations`, `oxy_repo_map` and
  `oxy_code_map_status` are available through Oxytocin's MCP server for enabled projects. Answers are bounded, report
  freshness and coverage, and use an explicit checkout selection. Configure MCP access from the Code Map settings tab.
- **Code Map:** enable it in Project settings → Code Map to keep a local, deterministic map of the project's code in
  `.oxy/` (ignored by Git unless you choose otherwise). It updates in the background while Oxytocin runs. Agents can read
  `.oxy/code-map/MAP.md`; copy ready-made agent instructions from the tab. TypeScript and JavaScript symbols, imports and
  calls; other files appear as files.
- **Code Map:** C# support — solutions and projects, namespaces, types and members, `using` directives and project
  references, and calls resolved from declared types. Partial types appear once with all their declarations; `bin/` and
  `obj/` next to a project file are skipped.

### Fixed

- **macOS release checks:** ESLint gets an explicit 4 GiB heap limit for type-aware linting instead of exhausting
  Node's default heap. Regular CI now checks Windows, Linux and macOS before release workflows.
- **Windows release tests:** the learning archive recovery test uses canonical paths so differences in temporary
  directory casing do not prevent its simulated write failure. The C# test that generates and parses 1001 files has
  a dedicated 30-second timeout to tolerate parallel test load.

## [0.9.10] - 2026-10-19

### Changed

- **Task:** a Claude Code planner starts in a new session in plan mode (Opus, high effort) with bypass permissions in
  its Shift+Tab cycle, so exploring asks no permission questions. Its finished plan goes straight to Task instead of an
  approval question in the terminal, shown as Markdown with the status **Plan awaiting approval**. **Approve &
  implement**, **Revise** (your feedback is pasted into the planner's terminal and the revised plan arrives the same
  way) or **Reject**; every version is kept. While planning, edits inside the project and `git commit`, `push`,
  `checkout` and `reset` are denied for that session only; your Claude Code settings files are not changed. When
  Oxytocin does not answer, Claude Code asks in the terminal as usual.
- An empty workspace offers more than **New terminal**: start an AI agent directly, or open anything from the group's
  **+** menu (terminal profiles, agents, tools) with **Open…**.

### Fixed

- Prompts typed into agents by Task, Changes → Send to review, Ensemble, Scratchpad and plugins are submitted
  reliably. Long prompts, such as an approved plan, sometimes stayed in the agent's input box until Enter was pressed:
  Codex CLI on Windows reads a long paste slowly and took the Enter as part of it. Enter now follows once the agent has
  taken the paste in, and is sent again after a few seconds when the agent did not start.

### Added

- Plugin API 0.1.10: `oxy.agents.launch({ claudeArgs, env })` adds arguments and environment variables to a new agent
  session; `AgentLauncher.agent` names the CLI a launch choice starts.

## [0.9.9] - 2026-10-17

### Changed

- Task opens in the right sidebar and works in either sidebar, following the active project, or as a workspace tab.
  Its layout fits a narrow sidebar. Agent terminals started or reused by Task and Changes → Send to review are
  revealed and focused in the workspace.

### Added

- Plugin API 0.1.9: `oxy.ui.openPanel(…, { placement: 'sidebar' })` opens a tool in the right sidebar.

## [0.9.8] - 2026-10-17

### Added

- **Task:** a lightweight plan → approve → implement → optional review workflow. Choose agents, accounts and API
  profiles from the same list as **+ → AI Agents**. Claude Code's native plan document is captured automatically;
  plans can also be pasted or edited before approval. Approval saves a frozen document and sends only the task and
  that plan to the implementer. Start review manually when implementation is ready. Agents run in ordinary
  interactive terminals, with matching session reuse and a fresh-session option; tasks survive app restarts.
- **AI Agents launch commands:** configure a command with arguments for each CLI in Settings → AI Agents, such as
  `codex --yolo`. Commands apply to new sessions, including added accounts and Claude API profiles.
- **Changes → Send to review:** choose an agent from the usual AI Agents list to review staged, unstaged and
  untracked changes. Reuses a matching terminal or opens one. Edit the instruction and save it as the default in
  the review dialog; it is also available as `git.reviewPrompt` in Settings.
- **Plugin API 0.1.8:** shared agent launch choices and profile-aware launching with optional prompt delivery,
  existing-session selection, fresh sessions and Claude plan mode.

### Fixed

- **Usage Monitor freshness:** Claude subscription limits are polled every ten seconds as a fallback for missed
  filesystem notifications. Partial or failed reads are retried. Continuous file activity no longer postpones log
  ingestion indefinitely; same-size log and chat rewrites are detected. **Refresh usage data** in the sidebar menu
  and **Refresh data** in the dashboard rescan source files rather than repainting cached totals. Dashboard values
  also refresh periodically and when the panel becomes visible. Limit timestamps continue to show when the agent
  actually reported them; refreshing does not invent a new limit reading.
- Detects when Claude's status line configuration has been removed or changed and shows **Repair limit updates**
  in the sidebar and Usage settings. Repair preserves the previous status line backup.

### Removed

- The built-in **Relay** plugin. Its general-purpose plugin API additions remain available.

## [0.9.7] - 2026-10-16

### Added

- **Relay: hand work from one AI agent to the next.** The new built-in *Relay* plugin (*+* menu → *Tools → Relay*, or
  *Relay: Show Relay Panel*) works with the agents running in a project, on any of your accounts:
  - **Hand off at the limit.** When an agent finishes its turn and its account's 5-hour (or weekly) limit is at least
    90% used (adjustable), the next free agent in the order you set — e.g. Claude Code, then Codex CLI on your main
    account, then Codex CLI on a second account — gets your hand-off prompt, such as *"Continue the implementation
    after {from}; the status is in TODO.md"*. Agents whose account is nearly out are skipped; when nobody is free,
    Relay waits, also for the first agent's limit to start over, so the work can go round.
  - **Review after each turn.** When an author finishes a turn that changed files, the reviewer agent gets the review
    prompt with the names of the changed files; turns that end while the reviewer works are reviewed together, and
    the reviewer's own turns start nothing.
  - Relay types one short prompt per hand-off and nothing else — no status messages, no system prompts, no diffs (the
    agents read the files themselves) — so the agents' context and limits go to the work. It only types into an
    agent that waits for input and never over a question on screen; every hand-off shows a notification and is
    listed in the panel, where *Send now* also sends the prompt by hand.

### Changed

- **Usage Monitor: plan limits per account.** The sidebar card lists the limits of each account under its name —
  *Claude (main)*, *Claude (Work)*, *Codex (main)* — each window with how much is used, when it resets and when it was
  read (*28% of 5h limit · resets in 49 min · as of 10:07*). Codex CLI limits are shown with the others. Added
  accounts' sessions count towards the usage too (their transcripts, rollouts and chats are read from the
  accounts' folders), and accounts that share the main account's settings report their own Claude limits through
  the same status line. The limits are also available to other plugins.
- **Plugin API 0.1.7:** agent accounts (`oxy.agents.listAccounts`, `AgentSnapshot.accountId`), plan limits
  (`getLimits`, `reportLimits`) and `oxy.agents.sendPrompt` ([changelog](packages/plugin-api/CHANGELOG.md)).

## [0.9.6] - 2026-10-16

### Added

- **Several accounts of Claude Code, Codex CLI and Gemini CLI.** *Settings → AI Agents → Accounts* lists the main
  account of each agent and lets you **Add account** — e.g. a work subscription next to your own. An added account
  gets a folder of its own (`~/.oxytocin/accounts/<agent>/<name>`, passed to the CLI as `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME` or `GEMINI_CLI_HOME`), so it signs in separately and runs at the same time as the main account in
  other terminals; the main account stays exactly as it is. **Create and sign in** opens its first terminal, where the
  CLI asks you to log in; the e-mail and plan appear next to the account afterwards. In the **shared setup**
  (recommended) the account uses the main account's global instructions (`CLAUDE.md` through an import, `AGENTS.md`,
  `GEMINI.md`), agents, skills, commands, settings, plugins and MCP servers, while its sign-in, sessions, history
  and project memory stay separate; **Isolated** shares nothing. Folders are linked (junctions on Windows, no admin
  rights needed); where Windows refuses a file link, Oxytocin keeps a copy that follows the main file, and anything
  the account already has of its own is never overwritten. Accounts are in the **+** menu (*Claude Code · Work
  (you@work.com)*), resume after a restart on their own folder, report their agent status like the main account,
  and an account terminal never picks up `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from your environment.
  **Alias** copies a shell alias (`claude-work`) to use the account outside Oxytocin, and **Remove** deletes the
  account's folder (and, on macOS, its Claude Code Keychain entry) without touching the main account.

## [0.9.5] - 2026-10-15

### Added

- **Codex sees Oxytocin's tools.** *Settings → Agent Tools* connects Codex CLI to Oxytocin's MCP server, as it already
  did for Claude Code: **Connect** adds an `[mcp_servers.oxytocin]` entry to Codex's `config.toml` (`~/.codex`, or
  `$CODEX_HOME`) with the server's address, its access token and the terminal header, so every new Codex session can
  query the project's databases and APIs, read other terminals or ask you — without being told where the server is.
  Only that entry is written; the rest of the file (other servers, comments) stays as it is, and a file that is not
  valid TOML is never touched. Resetting the access token updates Codex's entry too, and **Copy config.toml entry**
  gives the same entry to paste by hand.

### Changed

- **Agent Tools in tabs.** *Settings → Agent Tools* has three tabs: **MCP server** (its status, the agents connected
  to it — Claude Code, Codex CLI, other MCP clients — and its settings), **Tools** (every tool agents can use, with its
  switch and policy) and **Recent calls**. The policy menus are wide enough for their labels.

### Fixed

- **Codex CLI's status.** A Codex agent that finished its turn no longer stays *waiting* (or *working* after your
  next message). Oxytocin now reads what Codex itself reports: its lifecycle state (OSC 7501, recent Codex builds:
  working, waiting for a permission, a question or a login, done) and otherwise the activity in its terminal title
  (a spinner while it works, *Action Required* while it waits for you). The bell Codex rings when a turn is complete
  no longer counts as a question, and a bell never turns off the detection from the terminal's output any more, so
  an agent that only rings becomes idle again once it is quiet.

## [0.9.4] - 2026-10-14

### Added

- **Database servers, configured once.** The new *Settings → Database Servers* holds the servers you work with:
  give each a name (e.g. `FIRMA_1`), an engine (SQL Server, PostgreSQL, MySQL/MariaDB, MongoDB, Oracle, ClickHouse,
  CockroachDB, Redis), its address, login and password (encrypted with the OS keychain) and TLS options.
  **Discover databases** connects with that login and lists the databases it can use (system databases hidden unless
  asked for): add the ones you want — or all of them — or add a database by name; each can carry notes for agents.
- **Link server databases to projects.** *Project settings → Databases → Add from servers…* lists the databases of
  your servers; pick the ones a project needs. A linked database is named `server/database` (`FIRMA_1/WMS_DB`,
  `FIRMA_2/WMS_DB`), is read-only by default and keeps its own access rules, limits and masking per project, while the
  host, login, password and TLS come from the server: change the server once and every project follows. Agents see
  the databases grouped by server — in the brief (`database server "FIRMA_1"` with its databases) and in
  `oxy_project_resources` (`server`, `databaseOnServer` and a `databaseServers` overview). Linked databases are never
  written to `.oxytocin/project.json`, and a removed server's databases are no longer offered to agents.
- **AI agents and their accounts.** The new *Settings → AI Agents* detects the coding agents installed on this
  computer — Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI (and the older `gh copilot` extension), Grok CLI,
  Kiro CLI, Kimi CLI, Qwen Code, OpenCode, Cursor CLI, Amp, Factory Droid, Aider, Goose and Crush — with their version
  and the account each one is signed in with: the e-mail address and plan of Claude Code and Codex, the Google account
  of Gemini CLI, the GitHub login of Copilot, the providers of OpenCode, or the API key variable in use. Only names,
  e-mail addresses and plans are read; tokens never leave the CLIs' files. Detection runs once on the first start and
  again with **Detect AI agents**. Local model servers (Ollama, llama.cpp) are found too, with their models.
- **AI agents in the + menu.** The **+** of a workspace has an *AI agents* section that starts a detected agent by
  name, e.g. *Claude Code (naszekonto@mail.to)* or *Codex CLI (you@example.com)*. They run exactly as when you type
  their command in a terminal — same login, settings and sessions; typing `claude` still works. Each agent can be left
  out of the menu (*In + menu*), and *Manage AI agents…* opens the settings.
- **API and local model profiles.** A profile runs Claude Code against another Anthropic-compatible API: GLM (Z.ai),
  Kimi (Moonshot AI), OpenRouter, OrcaRouter, DeepSeek, MiniMax, a local Ollama or llama.cpp server, or any other
  URL — with a model, an optional fast model and an API key stored encrypted. Starting it sets `ANTHROPIC_BASE_URL`,
  the key and the models for that terminal only; your Claude Code login and settings stay as they are. *Claude Code
  profile* next to a running Ollama or llama.cpp server creates one with its first model.
- **Ensemble: pick the crew members a task may use.** *Lead & crew* (still the default) shows your crew as switches:
  leave out, say, the tester and the lead is told only about the others. Nobody starts before the lead hands them work,
  and the choice is remembered for the next task.

### Changed

- **Ensemble's lead & crew, rebuilt to save time and tokens.** On a real task the crew took about three times as long
  and used about four times the usage limit of a single Claude Code session, and the implementer's context was
  compacted again and again. Following Anthropic's guidance on multi-agent work and on prompting the 5.5 models:
  - Every piece of delegated work starts the teammate in a **fresh session** with only the lead's brief — no more
    research reports, reviews and test output of the others typed along, and no session collecting piece after piece
    until its CLI compacts it. The lead continues a session (`same_session`) only to follow up on work the teammate
    just did, such as fixing review findings in its own change.
  - The lead is told **when delegating pays off and when it does not**: hand out self-contained work it can describe
    precisely, context-heavy side work (exploring code, reading API docs, running a slow test suite) and one review
    with fresh eyes; do steps that depend on what it just learned, small fixes and anything quick itself. Delegations
    follow a brief format — goal, context (what the lead already knows), scope (files), done-when check, what to
    report — so a teammate does not explore the code again.
  - Reports are short by design (outcome, files, how it was checked; file:line instead of pasted code or logs) and
    tell the lead who still works for it, with the elapsed time of the task, which Opus 5.5 uses to pace the work.
  - Crew members get the task as background only, do just their part and cannot delegate further.
  - **New base prompts for every role**: scope kept to what was asked, economical reading (search first, read the
    relevant parts, filter command output), a real check of every code change, every real problem in a review, the
    answer first in research.
  - **Models and effort as the docs recommend**: the lead and planner on Opus 5.5 at *high* (was *xhigh*), the
    implementer on Sonnet 5.5 at *medium* (was Opus), researchers at *medium*, the docs writer on Haiku 5.5. Claude
    Haiku 5.5 is in the model list.
  - An agent that ends its turn without submitting (newer models end turns with a progress report) is nudged twice to
    carry on before you are asked.
- Agents that edit files no longer run with fewer permissions than your own Claude Code sessions: with *bypass
  permissions* (or *auto*) as your default, an *Accept edits* agent keeps it instead of stopping at every command for a
  prompt. The permission option *Ask (default)* is now called *Your CLI setting*, which is what it always meant.
- *New Ensemble task* offers two ways to start: **Lead & crew** and **Custom pipeline** (the templates, renamed from
  *From a template*); *Customize first* stays.

### Removed

- The Ensemble **quick start**: *Lead & crew* covers it — the lead decides who researches, codes, reviews and tests —
  and fixed pipelines are built from a template.

## [0.9.3] - 2026-10-12

### Added

- **Ensemble: Lead & crew.** Set up your crew once — who is on it, which AI (Claude Code, Codex, Gemini CLI,
  OpenCode), model and effort each member runs on, whether it edits files, and who leads — and start a task with one
  prompt. The lead gets the task, works out what it needs and hands pieces to the crew as it sees fit: one teammate
  researches an API while another maps the code, the implementer writes the code, the reviewer and the tester check
  it, in parallel where the work allows. Members start only when they get work; at most *Agents at the same time*
  (4 by default) work at once and further work waits in a queue. Optionally a test command runs at the end (failures
  go back to the lead) and you approve the result. *Lead & crew* is the new default of *New Ensemble task*; the quick
  start and the templates with their fixed pipelines stay. The crew is stored in the `ensemble.crew` setting.
- **Usage Monitor: choose what the sidebar card shows.** Today's cost, the cost per hour, limits, active sessions
  (and how many) and the project line can each be hidden — from the card's **⋯** menu or the new *Sidebar card*
  section of the dashboard's Settings tab — e.g. to see only the usage without the active sessions.

### Changed

- **Ensemble is marked as beta**: a *Beta* badge next to its name (the **+** menu, the task list, *New Ensemble
  task*) and a notice at the top of the panel: it is not fully tested yet, so keep an eye on running tasks and review
  their changes before you merge them.
- Agents a lead (or planner) delegates to are asked for the result that fits their role: code from an implementer,
  a review with a verdict from a reviewer, a test report from a tester. What they write is committed with the stage's
  checkpoint even when the delegating agent is read-only.

### Fixed

- **Ensemble agents no longer fill their context window.** Every assignment typed the brief, the plan and every
  earlier result into the agent again, and the tool description told agents to call `oxy_ensemble_context` (the same
  again) after every message — in a loop of review rounds the implementer's CLI compacted its context again and
  again. An agent now gets each result once: later messages carry only the instruction and what is new to its session
  (the brief is in its system prompt; findings sent back are not repeated as results), and `oxy_ensemble_context`
  is only for an agent that lost track. In a typical plan → three review rounds → test fix run the implementer gets
  about a sixth of the text it got before. Results, review bodies and template variables inserted into messages are
  shortened, and `oxy_ensemble_context` has a size limit.
- A message that seemed not to reach an agent (it started working only after the 10-second check) is no longer typed
  a second time: the agent starting counts as the delivery and the inbox entry goes away.
- A delegated report that was not typed yet when the agent who asked for it finished its stage is dropped instead of
  restarting that agent.
- Running Ensemble tasks no longer copy their whole state every second when nothing time-based is pending.

## [0.9.2] - 2026-10-11

### Fixed

- **Linux and macOS packages.** 0.9.1 was published for Windows only: one of its new end-to-end tests failed on the
  Linux build machine, which held back the Linux and macOS packages. 0.9.2 brings every change of 0.9.1 to Linux and
  macOS (and their automatic updates); on Windows it is the same app as 0.9.1.

## [0.9.1] - 2026-10-11

### Added

- **Keyboard shortcuts at a glance.** The new keyboard button of the title bar (next to the settings) — or
  **Ctrl+Shift+/** (⌘⇧/ on macOS), *Help: Keyboard Shortcuts* and *Keyboard Shortcuts* in the app menu — shows every
  shortcut grouped by area: views, projects, terminals, agents, the code editor and diffs, dialogs. It follows your own
  shortcuts, searches titles and keys (`ctrl+shift`), and *Customize…* opens the shortcut editor (also *Customize
  Keyboard Shortcuts* in the app menu). On macOS it is also in the Help menu.
- **Sections of the left sidebar can be closed and added again.** Projects, Changes, Files and Usage (and the sidebar
  views of plugins) have a **×** that closes them and a **+** that adds a closed section — or a tool such as the
  scratchpad or the Run tool — right below. These sections belong to the left sidebar; tools still go anywhere. With
  everything closed the sidebar offers *Add section*, and *View: Focus Projects / Changes / Files* (Ctrl+Shift+E,
  Ctrl+Shift+G) and *Reveal in Files* bring a closed section back. *View: Reopen Closed Sidebar Sections* restores
  them all. Closed sections stay closed after a restart.

### Changed

- Settings are shown one section at a time: the *All settings* entry is gone and Settings opens on *Appearance*. The
  search still looks through every section.
- *Add project* in the PROJECTS header has a folder icon, so it is not mistaken for the section's new **+**.
- Choosing *Scratchpad* in the other sidebar's **+** menu moves the scratchpad there instead of only revealing it.

### Fixed

- **Ctrl+S saves the file you are editing.** With several files or diffs open, Ctrl+S in one of them could save the
  one opened last instead (or do nothing after that one was closed).
- **Memory no longer grows with every opened file and diff.** Each code editor and diff — including every file
  scrolled through in *Review all changes* — kept its shortcuts and its whole view in memory after it was closed.
- *View: Focus Changes*, *Focus Files* and *Focus Projects* work when the app was started with the left sidebar
  hidden: they open it and expand the section.
- Renaming a file in the FILES section to a name that differs only in case no longer overwrites another file of that
  name on case-sensitive file systems (Linux).
- A branch name starting with `-` is refused instead of reaching git as an option.
- No more "Object has been destroyed" error in the log when an update reached the window while the app was quitting.

### Security

- The code editor and diffs use DOMPurify 3.4.16 (two cross-site scripting fixes) instead of the 3.4.15 bundled with
  Monaco.

## [0.9.0] - 2026-10-09

### Added

- **Git actions in the CHANGES section.** Every file and folder has a checkbox that stages or unstages it (a folder
  shows when only some of its files are staged); hovering a row offers *Open file* and *Discard changes*. Above the
  list a commit message box and a **Commit** button commit what is staged — or, with nothing staged, every change —
  and its menu adds *Commit & Push*, *Amend Last Commit* and *Undo Last Commit* (the commit's changes go back to the
  staging area). The branch name opens a menu to switch to another branch, create one, stash the changes and pop the
  stash; next to it **pull** (↓ with the number of new commits), **push** (↑ with the commits to push), **fetch**, or
  **Publish** for a branch without an upstream. The section's **…** menu stages, unstages or discards everything and
  syncs; the context menus of files and folders have the same actions. Git's own message explains any failure.
- **Review.** *Review all changes* (the new button of the CHANGES section, *Review in Context* in a file's menu, or
  *Git: Review All Changes*) opens every changed file's diff one below the other, with a file list, *Viewed* marks
  that collapse a file until it changes again, a progress bar, and per file *Staged*, *Discard*, *Open file* and
  *Ask agent*. Select code in any diff and choose **+ Comment** (Ctrl+Alt+M) to add a review comment; comments are
  marked in the diffs and listed in the review, and **Send comments** hands all of them to an agent as one prompt with
  the code they are about. *Ask agent to review* asks an agent to review every change.
- **Ask agent about code.** Select code in a diff or a file and press **Ctrl+L** (or **✦ Ask agent** next to the
  selection, or the context menu): a dialog shows the code, offers *Fix*, *Explain*, *Review*, *Refactor*, *Add
  tests* and *Document* or your own instruction, and sends the prompt with the file, the lines and the code to the
  running agent you pick — pressed Enter right away, or only pasted (`editor.askAgent.submit`). *Copy* and *Add to
  scratchpad* keep it for later. Files and changed files have *Ask Agent About…* in their context menus.
- **Built-in code editor and FILES section.** The new **FILES** section of the left sidebar (collapsed at first)
  browses the project: folders load as you open them, files git ignores are dimmed, changed files have their git
  colour and letter, and it follows files created or deleted on disk. Files open in a Monaco editor tab (a preview
  tab until you edit it or double-click it) with syntax highlighting, find and replace, multiple cursors, folding,
  sticky scroll and the minimap; save with **Ctrl+S**. A file without edits follows changes on disk (an agent
  writing it); with edits Oxytocin shows a banner (*Reload* or *Keep mine*) and never overwrites a newer file without
  asking. Closing a tab or quitting with unsaved edits asks to save them. The FILES menus create files and folders,
  rename, delete (to the trash), copy paths and open files to the side or in the external editor.
- **Quick Open finds every file** of the active project (`Ctrl+Shift+O`; `%` lists files only, *Files: Go to File…*).
- `editor.preset` **`oxytocin`**: *Open in external editor* and terminal file links that go to the editor open files
  in the built-in editor instead. New settings `editor.code.fontSize`, `editor.code.wordWrap`, `editor.code.minimap` and
  `editor.code.maxFileSizeMb`.

### Changed

- Diffs can be edited: the right side (the file on disk) is editable, the arrows between the sides revert single
  changes and **Ctrl+S** saves. The diff toolbar adds *Staged*, *Discard changes*, *Ask agent*, *Review all changes*
  and *Open file* (the built-in editor at the current change); *Open in external editor* keeps opening your IDE.
- Diff, code editor and review tabs carry an icon, so the diff and the file of the same name are told apart.
- The scratchpad (and *Ask agent*) remove control characters such as escape sequences from what they paste into an
  agent's terminal, so text taken from a file can never end the paste early and type input of its own.

### Security

- The built-in editor and the FILES section only change files inside the project: saving, creating, renaming or
  deleting through a symbolic link that leads outside the project folder is refused (reading through links still
  works).

## [0.8.2] - 2026-10-07

### Added

- **Custom scripts in the Run tool.** **+** now offers *Run Profile…* and *Custom Script…*. A custom script is an
  existing script file of the project — a `.bat`, `.cmd`, `.ps1`, `.sh` (typed with suggestions, or picked with
  *Choose…*) — or a script written right in the form (batch, PowerShell or shell). It is listed below the detected
  apps, which are found as before, and runs, stops and shows its logs like them. Two options per script: *Visible to
  AI agents* (on by default; off, the agents' Run tools neither list nor start it) and *Always run in a new terminal
  tab* (every run opens a new terminal tab instead of a background terminal). *Open Script* in the row's menu opens
  the file.
- **Scripts that wait for a key.** A script that ends with `PAUSE` ("Press any key to continue . . .") shows *waiting
  for input* with a **Continue** button (also in its notification); agents continue it with `run_answer_prompt` and
  an empty answer.

## [0.8.1] - 2026-10-02

### Added

- **Ensemble quick start.** A new task now starts from one prompt: describe what the team should do, pick who works
  on it (the planner always leads; implementer, reviewer, API researcher, researcher and tester are toggles), choose
  whether you approve the plan and optionally a test command, and press *Start* (or Ctrl+Enter). The pipeline follows
  from the team. *Customize first* opens the same task in the builder — models, a precise prompt per role, stages —
  and the templates are still one click away under *From a template*.
- **The planner delegates.** Agents hand parts of their work to teammates with the new `oxy_ensemble_delegate` tool:
  the planner breaks the task down, sends research to its helpers (in parallel), waits for their reports — delivered
  to it as messages, without reminders meanwhile — and writes the plan on top of them. Helpers appear under the stage
  in the Flow view ("delegated to"), the waiting agent shows "waiting for …", and agents outside the pipeline are
  marked as helpers in the builder.
- **API researcher**, a new role: it maps the endpoints a task needs — method and path, parameters, authentication,
  request and response shapes as TypeScript types with examples, errors and pagination — from an OpenAPI document,
  a URL in the prompt or the project's APIs, which Ensemble agents now call through Oxytocin's resource tools
  (`oxy_project_resources`, `oxy_api_describe`, `oxy_api_request` and the database tools) with the access rules from
  *Project settings*. In Claude Code it may read web pages without asking.

### Changed

- The model of an agent is chosen from a list of real model ids — `claude-opus-5-5`, `claude-sonnet-5-5`,
  `claude-fable-5-1`, `claude-haiku-4-5`, the aliases and older models (and the current ids for Codex CLI, Gemini CLI
  and OpenCode) — or typed in with *Other…*. The role presets use the full ids.

### Fixed

- **Agents always know the task.** An agent started without the brief and could ask what the task was about: its
  first message only said to fetch the details with a tool, and the CLI connects its MCP tools in the background
  after start-up. Now the brief is part of every agent's system prompt, each assignment is typed into the agent with
  its whole context (instruction, brief, the results of earlier stages), and the first message waits until the
  agent's CLI has connected to Ensemble (up to 20 seconds). Codex CLI, Gemini CLI and OpenCode also get the Ensemble
  rules with their first assignment. Long messages are typed in slices; on Windows they are typed as one line (line
  breaks shown as ↵), so a line break can never send half a message.
- The model field offered only the models matching what was already typed (with `opus` set: just `opus` and
  `opus[1m]`).

## [0.8.0] - 2026-10-02

### Added

- **Ensemble: tasks run by a team of AI agents.** A new tool in the "+" menu of a project's workspace. Describe a
  task, pick a template (*Feature*, *Bugfix*, *Review only*, *Research spike*, *Refactor with tests*, *Second
  opinion* or *Blank*) and adjust the team and the pipeline in the builder: every agent has its own CLI (Claude Code,
  Codex CLI, Gemini CLI, OpenCode or a custom command), model, effort, permission mode, role prompt and can be made
  read-only; stages are agent steps, *Implement ⇄ Review* loops with a round limit, parallel reviewers, tests
  (a command that sends failures back to the implementer) and gates where you approve, edit the plan or request
  changes. Checks and a prompt preview show what each agent will get before you start.
- **Runs you can watch and steer.** The *Flow* view shows the stages, the agents with their live state, what each
  agent handed to the next one and every decision of the conductor; click an agent to peek at its terminal, *Take
  over* to type into it yourself and *Hand back* when done. *Agents* shows all agent terminals side by side,
  *Activity* the whole timeline with a live log, *Changes* the diff of the task (or of one stage) and *Artifacts*
  the plans, reviews and results. Pause, resume, stop, send an agent a message or mark a stage as done; a run that
  was active when Oxytocin closed can be resumed with the agents' sessions.
- **Agents talk to each other — and to you.** Agents ask teammates or you questions; yours wait in the *Needs you*
  inbox together with open gates, and an optional advisor agent can be consulted at chosen moments. A status bar
  item, the attention badge and Ctrl+Shift+J take you to what needs you; OS notifications arrive when the window is
  in the background.
- **Its own worktree per task.** By default a task runs on a new branch in a git worktree next to the repository
  (setup commands and copied files such as `.env` are configurable; `ensemble.worktreeRoot` moves the folder),
  with a checkpoint commit after each stage, so your checkout is never touched. *Finish* merges the branch, squashes
  it into one commit, keeps the branch or discards everything; *Copy summary* gives a Markdown report for a pull
  request. Read-only teams can also work in the current checkout.
- **Costs and limits.** With the Usage Monitor running, every agent card shows what its sessions cost and the task
  shows the total; a budget, a maximum running time and the number of agents working at once pause or queue the
  task. The Usage Monitor offers the command `oxytocin.usage-monitor.totals` for this.
- **Isolated by design.** Models, efforts and prompts are passed per session on the command line: your CLI
  settings files, default model and other terminals stay exactly as they were. Agents reach Ensemble through a
  separate endpoint of Oxytocin's MCP server (`/mcp/ensemble`, with a token per agent); the tools other agents see
  are unchanged, and nothing runs unless you start a task. Settings `ensemble.worktreeRoot` and `ensemble.commands`
  (the command per CLI).

### Fixed

- An API resource whose base URL comes from a Project Runner profile now resolves to the running app's URL; it
  always fell back to the fallback URL before.

## [0.7.1] - 2026-10-01

### Added

- Plugin API 0.1.6: `oxy.ui.showNotification({ …, signal })` withdraws a notification with buttons (it closes and
  resolves `undefined`); notifications with buttons that time out now close instead of staying on screen.

### Fixed

- **Run: a question of a starting app is asked once.** When an app asks something while starting (Angular's "Port
  4200 is already in use… (Y/n)"), the question appeared both in the Run view and as a notification, and answering
  one left the other behind, its buttons sometimes doing nothing. Now the notification only appears when no Run view
  on screen shows the question, closes as soon as the question is answered (in the view, the notification or the
  terminal) or the Run view is opened, and its buttons keep working when the app redraws the question.
- **A crashed window comes back by itself.** If the window's renderer crashes (out of memory, a GPU or driver
  problem), Oxytocin reloads it within a second; terminals, agents and running processes keep running and reconnect
  with their output. After three crashes within a minute it asks whether to reload or quit instead of looping.
- **A hung window can be reloaded.** When the window stops responding, a dialog offers *Wait* or *Reload* and
  closes by itself if the window recovers.
- **No more accidental reloads, DevTools or closing from stray shortcuts.** Electron's built-in menu acted on keys
  the page did not handle: Ctrl+R / Cmd+R reloaded the whole window outside terminals, Ctrl+Shift+I opened the
  DevTools and Ctrl+W asked to quit. Oxytocin now has its own menu: on macOS the native menu bar (*About*,
  *Check for Updates…*, *Settings…* (Cmd+,), *Command Palette…*, editing, window and *Show Logs Folder* items); on
  Windows and Linux only full screen (F11) remains.
- A failed start now shows the error and exits instead of leaving an invisible process behind, which made new starts
  do nothing until it was ended in the task manager.
- In development builds each event from the app (toasts, "new terminal" from plugins) was handled twice.
- Unhandled errors are logged once instead of twice, and crashes of Electron's helper processes (GPU, network) are
  logged.

## [0.7.0] - 2026-09-30

### Added

- **Databases and APIs for your agents.** *Project settings* (right-click a project) is now a larger dialog with tabs,
  and describes the project's **resources**: databases (PostgreSQL, CockroachDB, SQL Server, MySQL, MariaDB, MongoDB,
  SQLite, Redis/Valkey, ClickHouse, Oracle), HTTP APIs (base URL or a Run profile's URL, bearer/basic/API-key/header
  authentication, OpenAPI), log files, links and related projects. *Test connection* shows the server version and
  latency or a clear error (authentication, host unreachable, TLS, missing database, timeout); *Import from project…*
  finds connection strings in `.env`, `appsettings*.json`, Spring `application.properties`/`.yml`, docker-compose and
  Prisma files and either references the env variable (nothing copied) or copies the connection into Oxytocin.
- **The bridge.** Agents use the resources through new tools of Oxytocin's MCP server — `oxy_project_resources`,
  `oxy_db_schema`, `oxy_db_query`, `oxy_mongo`, `oxy_redis`, `oxy_api_describe`, `oxy_api_request` and
  `oxy_logs_tail` — which are only offered once a project has such a resource. Oxytocin adds the credentials (they
  never reach the agent) and enforces what you allowed per database: **read-only** (the default: a real SQL parser
  per dialect lets through only plain reads — one statement, built-in functions, no `SELECT … INTO`, `FOR UPDATE`,
  sleeping, file or network functions — and reads also run in read-only transactions), **ask before writes** (every
  other statement is shown to you in full, with *Allow* / *Deny*) or **read-write** (still asking before `DROP`,
  `TRUNCATE` and `UPDATE`/`DELETE` without `WHERE`); production databases cannot be read-write. MongoDB and Redis get
  operation and command allowlists. APIs only receive the methods and paths you allow, only at their own origin.
  Results are capped (rows, bytes, time) and say how many rows exist; columns such as `password_hash` or `api_token`
  are masked (`***`); secrets never appear in errors.
- **Secrets are encrypted** with the operating system's keychain (DPAPI, Keychain, libsecret/KWallet) and can only be
  written from the dialog, never read back. On Linux without a keyring the dialog says that they are only obfuscated.
- **Agents are told about the resources:** in the MCP server's instructions (for the project of the terminal they run
  in), with the first prompt of every Claude Code session (through the Claude Code Bridge hooks), and — when you
  choose it on the new *Agents* tab — in a managed block of `AGENTS.md` or `CLAUDE.md`. The *Agents* tab also shows the
  brief and the project's recent tool calls with their queries.
- Resource tool calls keep the query or request line in the call log (Settings → Agent Tools), never the results.
- *Save to repository* writes the resources without secrets and production hosts to `.oxytocin/project.json`; when a
  repository with this file is opened, Oxytocin asks once per version before using it.
- Links of a project appear in its context menu; related projects share the resources they mark *Share with related
  projects*, and the *Related projects* tab suggests `claude --add-dir` for their code.
- Database drivers run in a new **Connections Host** process that starts on first use and stops after 10 idle
  minutes; its connection pools close after 5 idle minutes, so projects without resources pay nothing.

## [0.6.5] - 2026-09-30

### Added

- **One MCP server for your AI agents.** Oxytocin runs a local MCP server (`oxytocin`, 127.0.0.1 only, protected by a
  token) that Claude Code, Codex CLI, Cursor and other agents connect to once. It offers Oxytocin's own tools — list
  the projects and terminals, read the output of another terminal (a dev server, a test run), notify you, ask you a
  question in a dialog, open a file for you — plus the tools of your plugins. When you turn a plugin on or off, its
  tools appear or disappear in running agent sessions without reconnecting (for agents that support MCP's live tool
  updates; others see them in their next session).
- **Settings → Agent Tools**: the server's status, **Connect Claude Code** (one click, no re-connecting when plugins
  change), copyable config for other clients, *Reset token*, every tool with an on/off switch and *Run without
  asking* / *Ask first* / *Blocked*, and a log of recent calls (without their arguments). Tools that change or delete
  something ask first by default: *Allow once*, *Always allow* or *Deny* — also with a system notification when
  Oxytocin is in the background. Open it with *Agent Tools: Open* in the command palette.
- Oxytocin knows which terminal an agent calls from (Claude Code passes it along), so tools act on the right project
  without being told the folder.
- **Plugins can give agents tools** (plugin API 0.1.5): `contributes.mcp` with a tool prefix and the tools, the
  `mcp.tools` permission (the consent dialog lists the tools), `onMcpTool:<name>` activation and
  `oxy.mcp.registerTool(…)`, also for tools added at runtime. See *Tools for AI agents* in the plugin docs.

### Changed

- **Project Runner: its agent tools moved into Oxytocin's MCP server** as `run_list_profiles`, `run_start_profile`,
  `run_restart_profile`, `run_stop_profile`, `run_get_logs`, `run_answer_prompt` and `run_add_profile`. The Run tool's
  *Connect Claude Code* button and the *Run: Connect Claude Code (MCP)* command are gone: **Agent Tools** at the bottom
  of the Run tool opens the new settings. If you connected Claude Code to the old `oxytocin-runner` server, it keeps
  working for this release; **Connect Claude Code** in Agent Tools replaces it (and removes the old entry from Claude
  Code). `projectRunner.mcp.enabled` and `projectRunner.mcp.port` only affect that old server and will be removed;
  `projectRunner.claudeCommand` is replaced by `mcp.claudeCommand`.

### Fixed

- **Terminals restored after a restart** no longer show old prompt lines several times, lose the last lines of the
  restored output or leave the cursor invisible. On Windows the restored output now sits in the scrollback above the
  *Session restored* line, and the new shell starts on a clean screen below it (ConPTY expects an empty screen). The
  copy of each terminal that Oxytocin keeps for restoring resizes the same way as the visible terminal, so it no
  longer collects stale lines when a panel grows.

## [0.6.0] - 2026-09-29

### Added

- **One scratchpad per project.** The scratchpad's toolbar has **Share across projects** (on by default, as before).
  Turn it off and every project gets its own scratchpad; the current project keeps what you see. Turning it on again
  asks first when other projects have notes, because their scratchpads are replaced by the current one. Scratchpads
  are kept across restarts, also when you quit right after typing.
- **Run: apps that ask something while starting.** When an app waits for an answer (e.g. Angular's *"Port 4200 is
  already in use. Would you like to use a different port? (Y/n)"*), the Run tool shows *waiting for input* with the
  question and **Yes** / **No** (or a text answer) and **Open terminal**, the status bar says so, and a notification
  offers the same answers — instead of an endless *starting*. Agents see the question (`waitingForInput`) and can
  answer it with the new `answer_run_prompt` MCP tool.

### Changed

- **Oxytocin's own dialogs.** Quitting with running processes asks in an in-app dialog (listing the processes, with
  *Don't ask again*) instead of the system message box. Confirmations have a new look: an icon, the affected items as
  a list and a short fade-in.
- Plugin notifications show their action buttons (`oxy.ui.showNotification({ actions })`) and report the clicked one.

### Fixed

- **Rename** from a project's context menu no longer closes the name field right after it opened.
- Stopping an app (the Run tool's **Stop**, or Ctrl+C in a terminal) no longer shows *"Command failed"* when the app
  exits with an error code on Ctrl+C (e.g. `ng serve`); a terminal killed on request no longer reports *"Process
  exited with code …"*.

## [0.5.3] - 2026-09-29

### Changed

- **The Run tool is shown only when you add it.** The Project Runner no longer has a fixed section in the left sidebar:
  add **Run** from **Add tool** in the right sidebar (or the workspace's **+** menu). If you used the Run section,
  add it once again. Apps, run profiles, the status bar count and the MCP server work as before.
- **Tools move between the sidebars.** Every tool of the right sidebar (Run, the scratchpad, the JSON Formatter, plugin
  panels) moves to the left sidebar with its **Move to left sidebar** button or by dragging its section header there,
  and back the same way; a workspace tab's menu has **Move to left sidebar** too. The place is kept across restarts.

### Fixed

- Menus of plugin views (e.g. **⋯** of an app in the Run tool) no longer open partly off-screen near the right or
  bottom edge of the window; they open to the left or above instead. **Escape** closes them.
- *Run: Show Run Panel* (and the Run status bar item) reveals the Run tool where it is instead of opening a second one.

## [0.5.2] - 2026-09-29

### Fixed

- **Auto-update on Windows:** updates failed to download ("Cannot download … 0.5.1") because the installer was
  uploaded as `Oxytocin.Setup.x.y.z.exe` while the update manifest pointed at `Oxytocin-Setup-x.y.z.exe`. The installer
  is now named without spaces, and the release workflow checks that every file the update manifests list exists.
  Installed versions pick up 0.5.2 normally.
- The README release badge no longer shows "no releases or repo not found".
- **Scrollback after a restart** was sometimes lost (reliably on slower Windows machines): a layout save from the
  window that arrived while Oxytocin was quitting (a shell exiting, a title changing) overwrote the record of the
  saved terminal contents. Those saves now keep it. Terminals are also snapshotted all at once, so quitting with
  several terminals is faster.

### Changed

- **Update progress:** clicking the status bar entry while an update downloads opens a popover with a progress bar,
  the downloaded size and the speed. When the download finishes it offers **Install now** (restarts Oxytocin) or
  **On restart** (installs the next time you quit). A failed download shows *Update failed* in the status bar and
  the error with a **Retry** button in the popover.

## [0.5.1] - 2026-09-28

### Fixed

- **Project Runner on Windows:** agents' working directories are recognised in any spelling — 8.3 short names
  (`C:\Users\RUNNER~1`), symlinks and junctions, Git Bash (`/c/work/app`) and WSL (`/mnt/c/…`) paths — so the MCP
  tools find the project. The Run view no longer misses the active project when the app starts slowly.
- **Listening ports on localized Windows** (the state column of `netstat` is translated, e.g. *NASŁUCHIWANIE*) and on
  IPv6 (Vite listening on `::1`): the Run view shows the app's port again.
- **Runs are sturdier:** a double click or an agent starting an app that is already starting no longer opens a
  second terminal; *Stop* during start-up cancels it; the terminal is only reused while its shell is in the app's
  folder; apps that keep running are taken over again after the plugin restarts (a Plugin Host restart, reloading
  or re-enabling the plugin). Errors of Run/Stop/Restart are shown in the Run view.
- **File Preview** renders in a worker thread: previewing a large file no longer freezes the other built-in plugins
  (Usage Monitor, Project Runner), and a render that takes too long is cancelled.
- **Usage Monitor:** turning on the Claude subscription limits right after start-up is no longer lost.
- The *Connect Claude Code* state checks the registered port, and the `claude` CLI is only asked when a Run view
  opens (not at every start of Oxytocin).
- Terminal links resolve to real paths (symlinks, short names), so previews open for files of symlinked projects.

### Security

- The MCP server rejects requests whose `Host` is not a loopback name (DNS rebinding).
- Web links behind OSC 8 hyperlinks in terminals (their target is hidden behind the text) open with
  `Ctrl/⌘+click` only, like file links.
- A stray promise rejection no longer takes down the PTY Host (every terminal) or shows Electron's error dialog; it is
  logged.

## [0.5.0] - 2026-09-28

### Added

- **Previews from terminal links.** `Ctrl+click` (`⌘+click`) a file path in a terminal — `CLAUDE.md`, `src/app.ts:42`,
  a `file://` hyperlink — to open it in a **preview tab**: Markdown rendered, code highlighted with line numbers and
  scrolled to the line. A file that is already open is revealed instead of opened twice. Like every tool, a preview
  moves into the right sidebar by drag and drop and comes back after a restart. `Ctrl+Shift+click` opens the editor;
  the new `terminal.fileLinks.open` setting swaps the two.
- **Project Runner** (built-in plugin): detects the runnable apps of a project — Node.js scripts with their framework
  (Next.js, Vite, Angular, NestJS, …), .NET web/worker/console projects with their launch URLs, Django, FastAPI, Flask,
  Streamlit, Go, Rust, Spring Boot, Laravel, Rails, Deno, Docker Compose and Makefile targets — and runs them with one
  click from the new **Run** section (also a tool for the workspace and the right sidebar). Each app shows its status,
  the URL it serves (from its output or its listening ports) and its exit code; **Show logs** opens its terminal,
  **Stop** interrupts it. Edit detected apps or add your own **run profiles** (command, folder, environment) per
  project; they are kept across restarts. The status bar counts running apps.
- **MCP server for agents** in the Project Runner: Claude Code (or any MCP client) lists, starts, restarts and stops
  run profiles and reads their logs through a local, token-protected server; **Connect Claude Code** registers it.
  Apps started by an agent are marked in the Run section. Turn it off with `projectRunner.mcp.enabled`.
- Plugin API 0.1.4: background terminals (`create({ reveal: false, env })`, `show`), `kill`, `close`,
  `onDidWriteData`, `getListeningPorts`, richer `TerminalMeta` (cwd, running and last command) and line positions for
  file openers.

### Changed

- **Markdown Preview is now File Preview:** it also previews code and text files, and every code file gets **Open
  Preview** in the Changes list.
- Terminal file links also resolve paths relative to the project root, and typographic quotes („…”, “…”) around a
  file name no longer hide the link.

## [0.4.0] - 2026-09-28

### Added

- **Tools in the workspace.** The **+** of every tab group is now a menu: a new terminal (with the default or any
  other profile) or a **tool** — the scratchpad, the JSON Formatter or any plugin panel that declares
  `showInAddMenu`. Tools open next to the terminals and split, stack, float and move by drag and drop like them.
- **Modular right sidebar.** Drag a tool's tab onto the right sidebar (or use *Move to right sidebar* in the tab menu)
  to dock it there, and drag its section header back into the layout (or use *Move to workspace*). Every section can
  be closed, reordered and has **Add tool**; with every tool closed the sidebar offers to add one. The tools, their
  order and their state are kept across restarts.
- **Scratchpad formatting and settings.** A Markdown toolbar (bold, italic, strikethrough, code, code block, heading,
  lists, checklist, quote) with `Ctrl+B` / `Ctrl+I` / `Ctrl+E`, lists that continue on Enter, and a settings button
  for the font (mono, sans, serif), size, line height, line wrapping, spell checking and the toolbar itself — also in
  *Settings → Scratchpad*. The scratchpad can open as a workspace panel too; every copy edits the same notes.
- **JSON Formatter** (built-in plugin): format with 2 or 4 spaces or tabs, sort keys, minify, copy, and errors with
  their line and column.
- **Usage settings button.** A gear in the top-right corner of the Usage card opens the dashboard's **Settings** tab
  (billing, Claude subscription limits, prices), previously only reachable through the status bar.
- Plugin API 0.1.3: `contributes.panels[].showInAddMenu`.

### Changed

- **Usage Monitor with subscription billing:** when every agent in use is billed by subscription, the Usage card
  hides the API-equivalent costs (today's cost and tokens, burn rate, session and project costs) and shows the plan
  limits — or a link to turn them on. The status bar shows today's tokens instead of a cost when no limits are
  reported. The dashboard's *Pricing* tab is now called *Settings*.

## [0.3.1] - 2026-09-27

### Changed

- **Releases are built and published by GitHub Actions.** *Run workflow* on the Release workflow with a version
  bumps it, runs the full test suite and publishes the release with the Windows installer; the Linux and macOS
  packages are added when their builds succeed. Pushes to `main` only run the fast checks on Windows.

### Fixed

- **Windows:** a command started in a terminal shows as running right away again. Since 0.3.0 the busy-terminal
  sampling every 2 s could delay it by up to two seconds; the process tree is now sampled quickly for a few seconds
  after each command starts.

## [0.3.0] - 2026-09-27

### Added

- **Right sidebar.** A second column on the right of the workspace, as wide as the left sidebar by default
  (resizable, collapsible sections). Toggle it with the new title bar button or `Ctrl+Alt+B`
  (*View: Toggle Right Sidebar*).
- **Scratchpad** in the right sidebar for notes and prompt drafts, kept across restarts. **Send to agent**
  (`Ctrl+Enter` in the scratchpad) pastes the text into a running AI agent terminal without submitting it, so you can
  review it and press Enter. With a single running agent it goes there; with several it goes to the one you last
  used, or you pick one from the menu next to the button. *View: Focus Scratchpad* is in the command palette.
- **Settings button** in the title bar (next to the window controls). Settings were previously only reachable
  through the Oxytocin logo menu or `Ctrl+,`.

### Changed

- **Faster on Windows:** shell and agent detection (PATH lookups, `reg`, `wsl -l`) now runs in parallel and starts
  while the window loads, so the first terminal opens sooner. The process tree of busy terminals is sampled every
  2 s instead of every second, which halves the `fastlist.exe` spawns while agents are printing.

### Fixed

- A panel opened while a project's first terminal is still starting (for example Settings from the start-up
  "invalid value" notification) is no longer covered by the new terminal tab.

## [0.2.0] - 2026-09-27

### Added

- **Usage Monitor: Claude subscription limits.** An opt-in setting (Usage dashboard → Pricing → Claude
  subscription limits) shows the real 5-hour and weekly limits of a Claude Pro/Max plan, which Claude Code
  reports to its status line. Oxytocin sets a status line command in Claude Code's `settings.json`; a status line
  you already have keeps working and comes back when you turn the option off. With Claude Code billing set to
  Subscription, the limits get their own bars in the Usage sidebar (with reset times) and replace the cost in the
  status bar (`5h 24% · week 41%`).

## [0.1.0] - 2026-09-27

First MVP release: a desktop hub for developers who work with AI coding agents in the terminal.

### Added

- **Projects:** folders as projects with colours, pinning, drag-and-drop ordering and live status dots (agent
  working, waiting for you, process running, error); instant switching that keeps every process running; one
  workspace layout per project, restored after a restart (including terminal scrollback).
- **Terminals:** node-pty + xterm.js (WebGL) in a dockview center area with tabs, splits, drag and drop and preview
  tabs; shell detection (PowerShell, cmd, Git Bash, WSL, bash/zsh/fish) and agent launch profiles; Shift+Enter for
  newlines in agents, clipboard (image pastes are forwarded to agents), file links, search, flow control and a headless mirror for fast
  rehydration.
- **AI agents:** detection of Claude Code, Codex CLI, Gemini CLI, Aider and others from the process tree, Claude
  Code session registry and terminal signals; "working / waiting for you / idle" states, attention badge, OS
  notifications and a quit guard for running agents.
- **Changes:** live tree of files changed since `HEAD` (git porcelain v2 + file watching) with line counts, a
  Monaco diff viewer that updates while agents write, and "Open in editor" presets (VS Code, Cursor, Windsurf,
  Zed, JetBrains, Sublime Text, terminal editors, …).
- **Plugins:** HTML/JS/CSS plugins in sandboxed iframes with a backend in a separate Plugin Host process; sidebar
  views, center panels, status bar items, commands, file openers, terminal environment contributions, terminal
  profiles and agent rules; a minimal plugin manager with reload, logs and a developer mode; `@oxytocin/plugin-api`
  and `@oxytocin/plugin-sdk`.
- **Markdown Preview** (built-in plugin): live preview of plans and reports written by agents, with syntax
  highlighting, task lists, inlined images and link navigation.
- **Usage Monitor** (built-in plugin): tokens and USD cost of Claude Code, Codex CLI and Gemini CLI from their local
  logs (and optional OpenTelemetry), attributed to projects and terminals; live sessions, burn rate, 5-hour blocks,
  budgets with notifications, a dashboard with charts, sessions, budgets, pricing (LiteLLM prices, daily refresh,
  your own rates) and data sources. Only usage metadata is stored, locally.
- About dialog (version, MIT License) and Third-Party Notices.
- **Command palette** (`Ctrl+Shift+P`) and **Quick Open** (`Ctrl+Shift+O`: projects, terminals, changed files), also for
  plugins (`oxy.ui.showQuickPick`).
- **Keyboard shortcuts editor** and `keybindings.json` overrides with conflict detection.
- **Settings UI** generated from the settings schema (plugin settings included), with search, `@modified` and
  `@problems` filters.
- **Light theme** and "follow the system" (`appearance.theme`), also for plugin views.
- **Shell integration** for bash, zsh, fish and PowerShell: command start/finish marks, exit codes and
  "command finished" notifications.
- **Agent session resume** after a restart, a **project settings** dialog (name, colour, icon, environment, startup
  terminals, default profile) and **floating panel groups**.
- **User plugins:** install from a folder or a .zip (Plugins → Install…), a consent dialog with the plugin's
  permissions before it first runs, uninstall; installed and developer plugins run in their own Plugin Host.
- **`create-oxytocin-plugin`** (`npm create oxytocin-plugin`): a TypeScript plugin template (vanilla or React) with
  watch builds and packaging, and a [plugin developer guide](docs/plugins/README.md).
- **Claude Code Bridge** (built-in plugin): with the user's consent it installs Claude Code `http` hooks that report
  exact agent states (working, waiting for permission, finished) to Oxytocin; plugin API 0.1.2 adds
  `oxy.agents.reportState`.
- **Auto-update** from GitHub Releases (`latest` / `beta` channels): background download, installed when you quit
  or click *Restart to update* — never an automatic restart.
- Release pipeline: Windows/macOS code signing and notarization (activated by repository secrets) and hardened
  Electron fuses.

### Known limitations

- Builds are not code-signed yet (Windows SmartScreen and macOS Gatekeeper warn on first start).
- The Codex CLI log parser follows the documented format and still needs verification against more CLI versions.
