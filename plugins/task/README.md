# Task

A lightweight workflow opened by **Task: Plan and Implement a Task** in the right sidebar. Use the section header
buttons to move it to the left sidebar or the workspace; a workspace tab's menu offers **Move to right sidebar**.
In either sidebar, Task follows the active project and shows its name. It is also available in **+ > Tools > Task**.
Agent terminals open in the main workspace and are brought to front with keyboard focus.

The workflow:

1. Describe the task and choose a planner, an implementer and an optional reviewer from **+ → AI Agents**'s choices.
   Each role gets a **new session with a clean context**, unless you choose one of the role's running sessions.
2. Plan interactively in the planner's ordinary terminal. A new session starts with its first prompt on its command
   line (`claude "…"`, `codex "…"`, `gemini --prompt-interactive "…"`): nothing is typed into it and there is nothing
   to wait for. A Claude Code planner starts with
   `--model opus --effort high --permission-mode plan --allow-dangerously-skip-permissions --settings <file>`
   (API profiles keep their own model): it starts in plan mode, bypass permissions are in its Shift+Tab cycle, and
   exploring asks no permission questions. The settings file, written by Task for that session only, adds:
   - a `PreToolUse` hook on `ExitPlanMode` (an `http` hook to Task's local endpoint, `127.0.0.1` with a token; no
     shell is involved). It acts only in terminals with `OXYTOCIN_TASK_ID`. It hands the finished plan to Task, and
     **Claude waits there for your decision** (like Plannotator's plan review): the terminal shows no approval
     question. Pressing Esc in the terminal ends the wait and Claude takes questions in the terminal again; when
     Oxytocin does not answer, Claude Code asks in the terminal as usual and the plan is not lost;
   - deny rules: no edits inside the project and no `git commit`, `git push`, `git checkout` or `git reset`. Claude
     Code does not enforce plan mode's blocks when bypass is available, and it writes its plan file outside the
     project (`~/.claude/plans/` or `plansDirectory`).
   Your own `~/.claude/settings.json` and the project's `.claude/settings.json` are never changed. Implementers and
   reviewers start without these settings.
3. The plan appears in Task as Markdown with the status **Plan awaiting approval**. Your decision is Claude's answer:
   - **Approve & implement** ends the planner's turn and starts the implementer;
   - **Revise** sends your feedback and Claude revises the plan right away; the new version arrives the same way;
   - **Reject** ends the planner's turn and closes the task.
   Every version is kept under **Plan versions**. A chosen existing Claude session (no hook), or another agent, works
   as before: Claude's native plan document is captured, other agents write a Markdown document in Task's storage
   folder, or you paste the plan.
4. Task freezes the approved version and writes a brief (the task and the approved plan) to its storage folder. The
   implementer is told to read it; the folder is added to new sessions (`--add-dir`, `--include-directories`). No
   planner conversation or tool output is forwarded.
5. When implementation is ready, choose **Implementation ready · Review**, or mark the task done. Review receives
   the same brief and inspects the files itself. All stage transitions are manual.

A prompt for a session that already runs (feedback after Esc, a chosen implementer or reviewer) is typed as soon as
its agent waits for input: never over a running turn or a question on screen (trust, login, yes/no). Until then Task
shows what it is waiting for, with **Show terminal** and **Cancel**; there is nothing to retry. If that session ends
first, Task says so and the stage's retry opens a new session.

Tasks and their documents are saved in the plugin's storage, outside the repository, and survive app restarts.
Deleting a task from the list keeps its terminal sessions and document files.
