# Task

A lightweight workflow opened by **Task: Plan and Implement a Task** in the right sidebar. Use the section header
buttons to move it to the left sidebar or the workspace; a workspace tab's menu offers **Move to right sidebar**.
In either sidebar, Task follows the active project and shows its name. It is also available in **+ > Tools > Task**.
Agent terminals open or are reused in the main workspace and are brought to front with keyboard focus.

The workflow:

1. Describe the task and choose a planner, implementer and optional reviewer from **+ → AI Agents**'s choices.
2. Plan interactively in the planner's ordinary terminal. A Claude Code planner opens a new session with
   `--model opus --effort high --permission-mode plan --allow-dangerously-skip-permissions --settings <file>`
   (API profiles keep their own model): it starts in plan mode, bypass permissions are in its Shift+Tab cycle, and
   exploring asks no permission questions. The settings file, written by Task for that session only, adds:
   - a `PreToolUse` hook on `ExitPlanMode` (an `http` hook to Task's local endpoint, `127.0.0.1` with a token; no
     shell is involved). It acts only in terminals with `OXYTOCIN_TASK_ID`. It hands the finished plan to Task and
     tells Claude to stop, so the terminal asks no approval question. When Oxytocin does not answer, Claude Code asks
     in the terminal as usual and the plan is not lost;
   - deny rules: no edits inside the project and no `git commit`, `git push`, `git checkout` or `git reset`. Claude
     Code does not enforce plan mode's blocks when bypass is available, and it writes its plan file outside the
     project (`~/.claude/plans/` or `plansDirectory`).
   Your own `~/.claude/settings.json` and the project's `.claude/settings.json` are never changed. Implementers and
   reviewers start without these settings.
3. The plan appears in Task as Markdown with the status **Plan awaiting approval**. **Approve & implement** sends it,
   **Revise** pastes your feedback into the planner's terminal and the revised plan arrives the same way, **Reject**
   closes the task. Every version is kept under **Plan versions**. A chosen existing Claude session, or another
   agent, keeps the earlier behaviour: Claude's native plan document is captured, other agents write a Markdown
   document in Task's storage folder, or you paste the plan.
4. Task freezes the approved version and sends the task description and approved plan to the implementer. No planner
   conversation or tool output is forwarded.
5. When implementation is ready, choose **Implementation ready · Review**, or mark the task done. Review receives
   the description and approved plan and inspects the files itself. All stage transitions are manual.

Matching agent terminals are reused by default. You can select a particular existing session or request a fresh
one. Different roles using the same launch profile automatically get separate sessions. Reused sessions retain
their normal context and settings; choose a fresh session for an empty conversation. Busy agents and trust/login
questions receive no prompt: answer in the terminal and retry from Task.

Tasks and approved documents are saved in the plugin's storage, outside the repository, and survive app restarts.
If a saved terminal has been closed, retrying opens or reuses another matching terminal. Deleting a task from the
list keeps its terminal sessions and document files.
