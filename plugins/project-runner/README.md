# Project Runner

Built-in Oxytocin plugin: finds what a project can run, runs it with one click and shows its status, URL and logs — for
you and for your AI agents (through Oxytocin's MCP server).

## Detection

The project folder (3 levels deep by default, `projectRunner.scanDepth`) is searched for:

| Ecosystem | Detected from | Command |
|---|---|---|
| Node.js | `package.json` scripts (`dev`, `start:dev`, `develop`, `start`, `serve`, `watch`; plus `storybook`) — Next.js, Nuxt, Angular, SvelteKit, Astro, Remix, Gatsby, Vite (React/Vue/Svelte/Solid), CRA, NestJS, Expo, Electron, Express… | `npm run dev` / `pnpm run …` / `yarn …` / `bun run …` (from `packageManager` or the lock file, also in a monorepo root) |
| Deno | `deno.json(c)` tasks `dev`/`start`/`serve` | `deno task dev` |
| .NET | `*.csproj`/`*.fsproj`/`*.vbproj`: web (ASP.NET Core, Blazor), worker, console and Aspire AppHost projects; test and library projects are skipped. The URL comes from `Properties/launchSettings.json` | `dotnet run` |
| Python | Django (`manage.py`), FastAPI, Flask, Streamlit, a `main.py` with `__main__`; uses `uv run`, `poetry run`, `pdm run` or a `.venv`/`venv` interpreter | `python -m uvicorn app.main:app --reload`, … |
| Go | `go.mod` with `main.go` or `cmd/*/main.go` | `go run .`, `go run ./cmd/api` |
| Rust | `Cargo.toml` with a binary | `cargo run` |
| Java | Spring Boot (Maven or Gradle, wrappers preferred), Gradle `application` | `./mvnw spring-boot:run`, `./gradlew bootRun` |
| PHP, Ruby | Laravel (`artisan`), Rails (`bin/rails`) | `php artisan serve`, `bin/rails server` |
| Docker | `compose.yaml` / `docker-compose.yml` | `docker compose up` |
| Make | `dev`/`run`/`serve`/`start` targets of the root `Makefile` | `make dev` |

## Running

- The **Run** tool lists the apps of the active project. It is not shown until you add it: **Add tool** in the right
  sidebar (the section's **Move to left sidebar** button or a drag moves it to the left sidebar and back) or the
  workspace's **+** menu. It with **Run**, **Stop**, **Restart**, **Show logs** and a menu (edit, copy the
  command, reset, hide/delete). The status bar shows how many apps run.
- Every app runs in its own terminal, started in the background with the project's environment; **Show logs** opens it.
  The terminal is reused for the next run while its shell is idle.
- **Status:** *starting* → *running* once the app prints a local URL (Vite's `Local:`, ASP.NET's `Now listening on:`,
  Django, Uvicorn, …), a TCP port of the app's processes is listening or the command keeps running for a few seconds;
  *stopped* / *failed (exit N)* when the command ends (shell integration reports the exit code; without it the
  terminal's foreground process is followed). The URL opens in the browser.
- **Questions:** an app that asks something while it starts (Angular's "Port 4200 is already in use. Would you like to
  use a different port? (Y/n)", `[y/N]` prompts, "Enter …:") shows *waiting for input* with the question in the Run
  tool — **Yes**/**No** or a text answer, and **Open terminal** — and in the status bar, plus a notification with the
  same buttons. The answer is typed into the app's terminal.
- **Stop** sends Ctrl+C (answering cmd.exe's "Terminate batch job" prompt), a second Ctrl+C after 3 s and kills the
  process tree after 8 s.
- **Commands:** *Run: Start an App…* (quick pick), *Run: Stop All Apps*, *Run: Show Run Panel*.

## Run profiles

Detected apps can be edited (name, command, folder, environment variables, URL) and hidden; your own profiles are
added with **+**. Profiles are stored per project in the plugin's storage (`plugin-data/oxytocin.project-runner`) and
kept across restarts. Detection runs again when the Run tool is shown after 30 seconds; **Detect apps again**
rescans at once.

## Tools for agents

The plugin gives AI agents tools through Oxytocin's MCP server (`oxytocin`; connect Claude Code once in **Settings →
Agent Tools**, also reachable from **Agent Tools** at the bottom of the Run tool):

| Tool | Does |
|---|---|
| `run_list_profiles` | The project's profiles with status, URL and ports |
| `run_start_profile` / `run_restart_profile` | Starts (restarts) a profile and waits until it serves a URL, exits, asks a question or `wait_seconds` pass; returns the recent output |
| `run_stop_profile` | Stops a profile |
| `run_get_logs` | The last lines of a profile's output |
| `run_answer_prompt` | Types an answer (e.g. `y`) for a profile waiting for input (`waitingForInput` in its status) |
| `run_add_profile` | Saves a new profile for the project |

Every tool takes `cwd` (the agent's working directory selects the project) or `project`; without them the project of
the agent's terminal (or the active project) is used. Apps started by an agent are marked **agent** in the Run tool,
so you see what it runs. The tools can be turned off or set to ask first in Agent Tools like any other tool.

### Before Oxytocin 0.6.5

The plugin used to run its own server, `oxytocin-runner` on port 47286, with the same tools under other names
(`list_run_profiles`, `start_run_profile`, …). Where it was used it keeps running for this release, so Claude Code
sessions registered back then still work; **Connect Claude Code** in Agent Tools removes that old registration. The
settings `projectRunner.mcp.enabled` and `projectRunner.mcp.port` only control this old server and go away with it;
`projectRunner.claudeCommand` is replaced by `mcp.claudeCommand`.
