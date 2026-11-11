# Task

A lightweight workflow opened by **Task: Plan and Implement a Task** in the right sidebar. Use the section header
buttons to move it to the left sidebar or the workspace; a workspace tab's menu offers **Move to right sidebar**.
In either sidebar, Task follows the active project and shows its name. It is also available in **+ > Tools > Task**.
Agent terminals open in the main workspace and are brought to front with keyboard focus.

Task is the glue between ordinary agent terminals: every hand-over goes through a few files in the project, the same
way for every agent CLI. Nothing is read from an agent's conversation and nothing depends on an agent's plan mode.

## The files

Task keeps a task's files in the project, in `.oxy/tasks/`:

| File | Written by | Purpose |
|---|---|---|
| `.oxy/tasks/<task id>/raw.task.json` | Task | The task as you described it (`description`) |
| `.oxy/tasks/<task id>/plan.md` | the planner | The plan, in the outline below; the implementer ticks its steps |
| `.oxy/tasks/<task id>/claude-<role>-settings.json` | Task | `--settings` of a Claude Code session started by Task |
| `.oxy/tasks/skills/plan.md`, `implement.md`, `review.md` | Task | The built-in skills: how each role works |
| `.oxy/tasks/.gitignore` | Task | `*`: Git ignores the whole folder |

The folder of a task is removed when you mark the task done, reject its plan or delete it; the shared files go with
the last task, and `.oxy` itself when nothing else (a Code Map) is in it. The plan and its progress stay in Task's own
storage, so a completed task can still be read in Task. Files removed by hand come back with the next prompt.

The skills are plain instruction files, not skills installed into `~/.claude` or `~/.codex`: a prompt names the file
to follow, so they work with every agent and are read once per session.

## The plan outline

The planning skill asks for this outline, which Task parses and shows as steps with their files, a verification
checklist and progress:

```markdown
# <Short title of the change>

## Summary
<What changes, why, and the approach.>

## Steps

### [ ] 1. <Step title>
Files: `path/from/project/root.ts`, `another/file.ts`

<What to change and how.>

## Verification
- [ ] `<command to run>`

## Risks
- <Optional; any other section is shown as it is>
```

A plan without a `## Steps` section with `###` steps is still taken: it is shown as the Markdown it is.

## The workflow

1. Describe the task and choose a planner, an implementer and an optional reviewer from **+ → AI Agents**'s choices.
   Each role gets a **new session with a clean context**, unless you choose one of the role's running sessions.
2. The planner starts with one line on its command line (`claude "…"`, `codex "…"`, `gemini --prompt-interactive "…"`):
   follow `skills/plan.md`, the task is in `raw.task.json`, write the plan to `plan.md`. Nothing is typed into a new
   session. You can talk to the planner in its terminal as usual.
3. When the planner's turn ends (or its plan file has not changed for ten seconds), the plan appears in Task with the
   status **Plan awaiting approval**:
   - **Approve & implement** starts the implementer. If you edited the plan in Task, the plan file gets your version.
   - **Revise** types your feedback into the planner's session; the rewritten file is the next version.
   - **Reject** closes the task and removes its files.
   Every version is kept under **Plan versions**. You can also paste a plan yourself.
4. The implementer is told to implement `plan.md` following `skills/implement.md`. It ticks each finished step
   (`### [x]`) and each passed check in the plan file, and Task shows the progress. No conversation is forwarded.
5. When implementation is ready, choose **Implementation ready · Review**, or **Mark done**. The reviewer reads the
   same plan file and `skills/review.md` and inspects the changes itself. All stage transitions are manual.

A Claude Code session started by Task gets `--settings <file>` with allow rules only: reading `.oxy/tasks` and, for
the planner and the implementer, editing the task's own folder, so that writing the plan and ticking steps ask no
permission. Your own `~/.claude/settings.json` and the project's `.claude/settings.json` are never changed, and the
agent runs with the model and the permission mode of the launcher you chose.

A new session gets its first prompt on its command line. If it has not started on it 30 seconds later (it waits for
input, or a question such as folder trust is open), Task says so with **Show terminal**.

A prompt for a session that already runs (feedback, a chosen implementer or reviewer) is typed as soon as its agent
waits for input: never over a running turn or a question on screen (trust, login, yes/no). Until then Task shows what
it is waiting for, with **Show terminal** and **Cancel**; there is nothing to retry. If that session ends first, Task
says so and the stage's retry opens a new session.

Tasks (their roles, plan versions and progress) are saved in the plugin's storage and survive app restarts. Closing
or deleting a task keeps its terminal sessions.
