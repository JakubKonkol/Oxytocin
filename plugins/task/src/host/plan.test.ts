import { describe, expect, it } from 'vitest';
import { parsePlan, planProgress, withProgress } from '../shared/plan';
import { SKILLS } from './skills';

const PLAN = `# Add a search field

## Summary
Adds a search field to the list.

It filters as you type.

## Steps

### [ ] 1. Add the field
Files: \`src/list.tsx\`, \`src/search.ts\`

Render an input above the list.

\`\`\`ts
// ## Not a section
### [ ] not a step
\`\`\`

### [x] 2. Filter the rows
**Files:** src/filter.ts, src/list.tsx

- Match case-insensitively.

### 3) Test \`filter\`
Nothing else.

## Verification
- [x] \`npm test\`
- [ ] Type "a" and
  see the rows narrow
* Check the empty state

## Risks
- Slow on long lists.
`;

describe('parsePlan', () => {
  it('reads the title, the summary, the steps with their files and the checks', () => {
    const plan = parsePlan(PLAN)!;
    expect(plan.title).toBe('Add a search field');
    expect(plan.summary).toBe('Adds a search field to the list.\n\nIt filters as you type.');
    expect(plan.steps.map((s) => [s.title, s.done, s.files])).toEqual([
      ['Add the field', false, ['src/list.tsx', 'src/search.ts']],
      ['Filter the rows', true, ['src/filter.ts', 'src/list.tsx']],
      ['Test `filter`', false, []],
    ]);
    // Headings inside a code block belong to the step.
    expect(plan.steps[0]!.body).toContain('### [ ] not a step');
    expect(plan.steps[0]!.body.startsWith('Render an input')).toBe(true);
    expect(plan.steps[1]!.body).toBe('- Match case-insensitively.');
    expect(plan.steps[2]!.body).toBe('Nothing else.');
    expect(plan.checks).toEqual([
      { text: '`npm test`', done: true },
      { text: 'Type "a" and\n  see the rows narrow', done: false },
      { text: 'Check the empty state', done: false },
    ]);
    expect(plan.sections).toEqual([{ title: 'Risks', body: '- Slow on long lists.' }]);
  });

  it('accepts Windows line endings, front matter, a missing title and text before the first section', () => {
    const plan = parsePlan('---\r\nowner: me\r\n---\r\nIntro.\r\n\r\n## Steps\r\n### Step one\r\nDo it.\r\n')!;
    expect(plan).toMatchObject({ title: '', summary: 'Intro.', steps: [{ title: 'Step one', done: false }] });
  });

  it('keeps a verification section that is not a list, and sections after a second title', () => {
    const plan = parsePlan('# A\n## Steps\n### One\n## Verification\nRun everything.\n# B\nMore.\n')!;
    expect(plan.checks).toEqual([]);
    expect(plan.sections).toEqual([
      { title: 'Verification', body: 'Run everything.' },
      { title: 'B', body: 'More.' },
    ]);
  });

  it('does not take a document without steps for a structured plan', () => {
    expect(parsePlan('# Plan\n\nJust do it.\n\n## Steps\n\nNo headings here.')).toBeNull();
    expect(parsePlan('')).toBeNull();
    expect(planProgress('Just do it.')).toBeNull();
  });

  it('reads the ticks and applies them to the approved plan by position', () => {
    const progress = planProgress(PLAN)!;
    expect(progress).toEqual({ steps: [false, true, false], checks: [true, false, false] });
    const approved = parsePlan(PLAN.replace('[x] 2.', '[ ] 2.').replace('- [x]', '- [ ]'))!;
    expect(approved.steps.some((s) => s.done)).toBe(false);
    const shown = withProgress(approved, { steps: [true, true], checks: [] });
    expect(shown.steps.map((s) => s.done)).toEqual([true, true, false]);
    expect(shown.checks.map((c) => c.done)).toEqual([false, false, false]);
    expect(withProgress(approved, undefined)).toBe(approved);
  });

  it('parses the plan the planning skill shows as its format', () => {
    const template = /```markdown\n([\s\S]*?)\n```/.exec(SKILLS.planner.text)![1]!;
    const plan = parsePlan(template)!;
    expect(plan.title).not.toBe('');
    expect(plan.summary).not.toBe('');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ done: false, files: ['path/from/project/root.ts', 'another/file.ts'] });
    expect(plan.steps[0]!.title).toBe('<Step title, imperative>');
    expect(plan.checks).toHaveLength(2);
    expect(plan.sections.map((s) => s.title)).toEqual(['Risks', 'Open questions']);
  });
});
