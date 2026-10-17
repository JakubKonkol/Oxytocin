# Task

A lightweight workflow opened by **Task: Plan and Implement a Task** in the right sidebar. Use the section header
buttons to move it to the left sidebar or the workspace; a workspace tab's menu offers **Move to right sidebar**.
In either sidebar, Task follows the active project and shows its name. It is also available in **+ > Tools > Task**.
Agent terminals open or are reused in the main workspace and are brought to front with keyboard focus.

The workflow:

1. Describe the task and choose a planner, implementer and optional reviewer from **+ → AI Agents**'s choices.
2. Plan interactively in the planner's ordinary terminal. New Claude sessions can start in plan mode; for a reused
   session, enable `/plan` yourself first. A launch command such as `claude --model opusplan` is configured in
   **Settings → AI Agents → Launch commands**.
3. Claude's native plan document is captured from the selected session. Other agents are asked to write a Markdown
   document in Task's storage folder. If a CLI stores its plans elsewhere, paste the plan into the document field.
4. Read or refine the plan and choose **Approve & implement**. Task freezes the approved version and sends the task
   description and approved plan to the implementer. No planner conversation or tool output is forwarded.
5. When implementation is ready, choose **Implementation ready · Review**, or mark the task done. Review receives
   the description and approved plan and inspects the files itself. All stage transitions are manual.

Matching agent terminals are reused by default. You can select a particular existing session or request a fresh
one. Different roles using the same launch profile automatically get separate sessions. Reused sessions retain
their normal context and settings; choose a fresh session for an empty conversation. Busy agents and trust/login
questions receive no prompt: answer in the terminal and retry from Task.

Tasks and approved documents are saved in the plugin's storage, outside the repository, and survive app restarts.
If a saved terminal has been closed, retrying opens or reuses another matching terminal. Deleting a task from the
list keeps its terminal sessions and document files.
