import type { RoleName } from '../shared/task';

/**
 * Task's built-in skills: the instructions each role follows, written to `.oxy/tasks/skills/` of the project (not to
 * the agents' own skill folders). A prompt only names its skill file and the task's files, so the rules are read once
 * per session, are the same for every agent CLI, and the plan always has the outline Task can parse.
 */
const PLAN_SKILL = `# Oxytocin Task: write the plan

You plan a task for the user. Oxytocin's Task panel shows your plan to the user for approval. A separate agent
implements it afterwards and sees only the plan file, not this conversation.

1. Read the task file named in your prompt (\`raw.task.json\`). Its \`description\` is the user's request.
2. Explore the code as far as the plan needs. Ask the user in this terminal only when a decision blocks the plan.
3. Write the plan to the plan file named in your prompt (\`plan.md\`), in the format below, in one write. Create or
   change no other file and implement nothing.
4. End your turn with one short sentence. Oxytocin reads the file itself: do not print the plan.

When the user sends feedback, rewrite the whole plan file in the same format.

## Format

Oxytocin parses the plan, so keep this outline and these headings exactly:

\`\`\`markdown
# <Short title of the change>

## Summary
<Two to five sentences: what changes, why, and the approach.>

## Steps

### [ ] 1. <Step title, imperative>
Files: \`path/from/project/root.ts\`, \`another/file.ts\`

<What to change and how: functions, behaviour, edge cases.>

### [ ] 2. <Next step>
Files: \`path/to/file.ts\`

<...>

## Verification
- [ ] \`<command to run>\`
- [ ] <Something to check by hand>

## Risks
- <Only when there are any>

## Open questions
- <Only when something is left for the user to decide>
\`\`\`

Rules:
- Steps are in the order to implement them. Each one is self-contained and names every file it touches in its
  \`Files:\` line (paths relative to the project root, in backticks).
- Write for an agent that has not seen the code: name the functions and types to change and the behaviour expected.
  No code dumps; a short snippet only where it removes doubt.
- Leave every box unticked: the implementer ticks them.
- Omit \`## Risks\` and \`## Open questions\` when they would be empty. Add no other sections.
`;

const IMPLEMENT_SKILL = `# Oxytocin Task: implement the plan

The plan file named in your prompt (\`plan.md\`) was written by a planning agent and approved by the user.
\`raw.task.json\` next to it holds the user's original request.

1. Read the whole plan first.
2. Implement the steps in order. Follow the project's own instructions (CLAUDE.md, AGENTS.md and the like).
3. When a step is finished, tick it in the plan file: change its heading from \`### [ ]\` to \`### [x]\`. Oxytocin
   shows this progress to the user. Change nothing else in the plan file.
4. Run the checks under \`## Verification\` and tick (\`- [x]\`) the ones that pass.
5. Apart from those ticks, leave the \`.oxy/tasks\` folder alone. Git ignores it and Oxytocin removes the task's
   files when the user closes the task.
6. Finish with a short summary: what was done, and what was skipped or differs from the plan and why.

If a step cannot be done as planned, stop and tell the user instead of improvising another design.
`;

const REVIEW_SKILL = `# Oxytocin Task: review the implementation

1. Read the plan file named in your prompt (\`plan.md\`, approved by the user) and \`raw.task.json\` next to it (the
   user's original request).
2. Inspect the current changes in the repository (\`git status\`, \`git diff\`) against them.
3. Look for bugs, regressions, missing requirements, and steps or checks that are ticked but not done.
4. Report actionable findings as a concise list with file and line references. Edit no file.
`;

export const SKILLS: Record<RoleName, { file: string; text: string }> = {
  planner: { file: 'plan.md', text: PLAN_SKILL },
  implementer: { file: 'implement.md', text: IMPLEMENT_SKILL },
  reviewer: { file: 'review.md', text: REVIEW_SKILL },
};
