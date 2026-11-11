/**
 * The plan document of a task (`.oxy/tasks/<id>/plan.md`). It is Markdown with a fixed outline, so that Task can show
 * it as steps with progress instead of plain text:
 *
 *     # Title
 *     ## Summary
 *     ## Steps
 *     ### [ ] 1. Step title
 *     Files: `src/a.ts`, `src/b.ts`
 *     What to do.
 *     ## Verification
 *     - [ ] `npm test`
 *     ## Risks            (any other section is kept as it is)
 *
 * The parser is lenient about everything but the outline: a document without steps is not a structured plan and is
 * shown as the Markdown it is, so a plan is never lost to its format.
 */
export interface PlanStep {
  title: string;
  done: boolean;
  /** Paths from the step's `Files:` line. */
  files: string[];
  /** The rest of the step, Markdown. */
  body: string;
}
export interface PlanCheck {
  text: string;
  done: boolean;
}
export interface PlanSection {
  title: string;
  body: string;
}
export interface StructuredPlan {
  title: string;
  summary: string;
  steps: PlanStep[];
  checks: PlanCheck[];
  /** Sections other than Summary, Steps and Verification, in document order. */
  sections: PlanSection[];
}
/** What the implementer ticked in the plan file, by position. */
export interface PlanProgress {
  steps: boolean[];
  checks: boolean[];
}

export const MAX_STEPS = 200;

const FENCE = /^\s{0,3}(```|~~~)/;
const STEP_HEADING = /^(?:\[([ xX]?)\]\s*)?(?:(?:step\s+)?\d+\s*[.):-]\s*)?(.*)$/i;
const FILES_LINE = /^(?:[-*]\s+)?(?:\*\*)?files?(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/i;
const LIST_ITEM = /^[-*+]\s+(?:\[([ xX]?)\]\s*)?(.*)$/;

interface Block {
  title: string;
  lines: string[];
}

/** Splits lines at headings of one level (`#` × level), ignoring headings inside code fences. */
function split(lines: string[], level: number): { before: string[]; blocks: Block[] } {
  const marker = new RegExp(`^#{${level}}\\s+(.*?)\\s*#*\\s*$`);
  const before: string[] = [];
  const blocks: Block[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const mark = FENCE.exec(line)?.[1];
    if (mark && !fence) fence = mark;
    else if (mark && mark === fence) fence = null;
    const heading = fence || mark ? null : marker.exec(line);
    if (heading) blocks.push({ title: heading[1]!, lines: [] });
    else (blocks.at(-1)?.lines ?? before).push(line);
  }
  return { before, blocks };
}

const text = (lines: string[]) => lines.join('\n').trim();

function files(value: string): string[] {
  const quoted = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const names = quoted.length > 0 ? quoted : value.split(/[,;]/).map((part) => part.trim());
  return names.filter((name) => name && !/^(none|n\/a|-|—)\.?$/i.test(name)).slice(0, 50);
}

function step(block: Block): PlanStep {
  const heading = STEP_HEADING.exec(block.title)!;
  const body = [...block.lines];
  while (body.length > 0 && !body[0]!.trim()) body.shift();
  const named = body.length > 0 ? FILES_LINE.exec(body[0]!.trim()) : null;
  if (named) body.shift();
  return {
    title: heading[2]!.trim() || block.title,
    done: /x/i.test(heading[1] ?? ''),
    files: named ? files(named[1]!) : [],
    body: text(body),
  };
}

/** The top-level list items of a section; text under an item belongs to it. `null` when it is not a list. */
function checks(lines: string[]): PlanCheck[] | null {
  const items: PlanCheck[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const mark = FENCE.exec(line)?.[1];
    const item = fence || mark ? null : LIST_ITEM.exec(line);
    if (mark && !fence) fence = mark;
    else if (mark && mark === fence) fence = null;
    if (item) items.push({ text: item[2]!.trim(), done: /x/i.test(item[1] ?? '') });
    else if (items.length > 0) {
      const last = items.at(-1)!;
      last.text = `${last.text}\n${line.trimEnd()}`.trimEnd();
    } else if (line.trim()) return null;
  }
  return items.length > 0 ? items : null;
}

/** The plan as Task shows it, or `null` for a document without `## Steps` (shown as plain Markdown). */
export function parsePlan(document: string): StructuredPlan | null {
  let lines = (document.charCodeAt(0) === 0xfeff ? document.slice(1) : document).split(/\r?\n/);
  // Front matter is not part of the plan.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) lines = lines.slice(end + 1);
  }
  const top = split(lines, 1);
  const main = top.blocks[0];
  // A second top-level heading does not end the plan.
  const rest = top.blocks.slice(1).flatMap((block) => [`## ${block.title}`, ...block.lines]);
  const sections = split(main ? [...main.lines, ...rest] : top.before, 2);
  const plan: StructuredPlan = { title: main?.title ?? '', summary: '', steps: [], checks: [], sections: [] };
  const intro = text(sections.before);
  for (const section of sections.blocks) {
    const name = section.title
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .trim();
    if (name === 'summary' && !plan.summary) plan.summary = text(section.lines);
    else if (/^(steps|implementation steps|plan)$/.test(name) && plan.steps.length === 0) {
      const steps = split(section.lines, 3);
      plan.steps = steps.blocks.slice(0, MAX_STEPS).map(step);
      const lead = text(steps.before);
      if (lead && plan.steps.length > 0) plan.sections.push({ title: section.title, body: lead });
    } else if (/^(verification|verify|checks|testing|tests)$/.test(name) && plan.checks.length === 0) {
      const items = checks(section.lines);
      if (items) plan.checks = items.slice(0, MAX_STEPS);
      else plan.sections.push({ title: section.title, body: text(section.lines) });
    } else plan.sections.push({ title: section.title, body: text(section.lines) });
  }
  if (plan.steps.length === 0) return null;
  if (intro) plan.summary = plan.summary ? `${intro}\n\n${plan.summary}` : intro;
  plan.sections = plan.sections.filter((section) => section.body);
  return plan;
}

/** The boxes ticked in a plan document, or `null` when it is not a structured plan. */
export function planProgress(document: string): PlanProgress | null {
  const plan = parsePlan(document);
  return plan ? { steps: plan.steps.map((s) => s.done), checks: plan.checks.map((c) => c.done) } : null;
}

/** The plan with the ticks of `progress`; the plan's own outline never changes. */
export function withProgress(plan: StructuredPlan, progress: PlanProgress | undefined): StructuredPlan {
  if (!progress) return plan;
  return {
    ...plan,
    steps: plan.steps.map((s, i) => ({ ...s, done: progress.steps[i] ?? s.done })),
    checks: plan.checks.map((c, i) => ({ ...c, done: progress.checks[i] ?? c.done })),
  };
}

export const sameProgress = (a: PlanProgress | undefined, b: PlanProgress | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
