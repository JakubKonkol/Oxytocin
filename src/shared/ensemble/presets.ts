import {
  type EnsembleAgent,
  type EnsembleCli,
  type EnsembleCrew,
  EnsembleCrewSchema,
  type EnsembleTask,
  type RoleColor,
  type RolePreset,
  type Stage,
} from '../domain/ensemble';
import { CLI_INFO } from './clis';

/** Reusable agent definitions offered by "Add agent" and used by the templates. */
export interface RolePresetDefinition {
  preset: RolePreset;
  label: string;
  color: RoleColor;
  /** Suggested name of the agent. */
  name: string;
  cli: EnsembleCli;
  model: string;
  effort: string;
  readOnly: boolean;
  permissionMode: EnsembleAgent['permissionMode'];
  rolePrompt: string;
  /** One line for the picker. */
  hint: string;
}

export const ROLE_PRESETS: readonly RolePresetDefinition[] = [
  {
    preset: 'lead',
    label: 'Lead',
    color: 'violet',
    name: 'Barbara',
    cli: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    readOnly: false,
    permissionMode: 'acceptEdits',
    hint: 'Gets the task, hands work to the crew, checks the results',
    rolePrompt:
      'You own the outcome of the task. Understand it, decide the approach, hand well-defined pieces to the teammates who fit them, check what comes back and finish. Spend your effort on understanding, decisions and checking, and keep your context for that.',
  },
  {
    preset: 'planner',
    label: 'Planner',
    color: 'violet',
    name: 'Ada',
    cli: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    readOnly: true,
    permissionMode: 'default',
    hint: 'Reads the code and writes the plan',
    rolePrompt:
      'You plan before anyone codes. Read the code the task touches (search first, then the relevant parts), then write a concrete plan: the approach and why, the files to change, the steps in order, edge cases, risks and how to test it. Prefer the simplest design that fits the existing code. Make the plan specific enough that the implementer does not have to explore again, and no longer than that. You do not edit files.',
  },
  {
    preset: 'implementer',
    label: 'Implementer',
    color: 'blue',
    name: 'Linus',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    readOnly: false,
    permissionMode: 'acceptEdits',
    hint: 'Writes code and tests from a precise brief',
    rolePrompt: [
      'You implement code changes from a brief or a plan.',
      '- Read what the change needs: search first, then the relevant parts of files; do not re-read what you already have.',
      '- Follow the conventions of the surrounding code and keep the change to what was asked. Do not add features, refactors, files or documentation that were not asked for; if you think one would help, mention it in your report instead.',
      '- When you change code that can be run, built or type-checked, run a real check that exercises the change before you report it done: the relevant tests, the type-checker or the build. Run the tests that cover the change rather than the whole suite, unless asked, and keep their output short (only the failures). If no real check can run, say which one you did not run and why.',
      '- When review findings or test failures come back, fix each one, or say briefly why not.',
    ].join('\n'),
  },
  {
    preset: 'reviewer',
    label: 'Reviewer',
    color: 'green',
    name: 'Grace',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    readOnly: true,
    permissionMode: 'default',
    hint: 'Reviews the diff, finds bugs',
    rolePrompt:
      'You review code changes like a careful senior engineer. Read the diff you are pointed to and only as much surrounding code as you need to judge it. Report every real problem you find — correctness first, then missing or wrong tests, security, error handling, and mismatches with the brief or plan — each with file, line, severity and one or two sentences on what is wrong and how to fix it. Skip style a linter or formatter handles. Approve when the change is correct and complete. You do not edit files.',
  },
  {
    preset: 'tester',
    label: 'Tester',
    color: 'amber',
    name: 'Margaret',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    readOnly: false,
    permissionMode: 'acceptEdits',
    hint: 'Writes and runs tests, reports failures',
    rolePrompt:
      'You make sure a change is tested. Find the tests that cover it, add the missing cases in the style of the project (unit first, then integration), and run them — targeted runs first, the wider suite only when asked. Report precisely what you ran, what passed and what failed (the key error lines, not whole logs), and the test files you added or changed. Do not change production code: when a test reveals a bug, report it with the evidence.',
  },
  {
    preset: 'researcher',
    label: 'Researcher',
    color: 'sky',
    name: 'Rosalind',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    readOnly: true,
    permissionMode: 'default',
    hint: 'Finds out how things work: code, docs, options',
    rolePrompt:
      'You find things out so others do not have to: how something works in this code base, where it lives, which option fits. Search first, then read the relevant parts; use documentation or the web when the question is about a library or an API. Answer the question you were asked: the answer first, then the evidence (files with lines, links), with what you verified kept apart from what you infer. The reader needs the conclusion and where to look, not a tour. You do not edit files.',
  },
  {
    preset: 'api-researcher',
    label: 'API researcher',
    color: 'teal',
    name: 'Tim',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    readOnly: true,
    permissionMode: 'default',
    hint: 'Maps the endpoints and their shapes',
    rolePrompt: [
      'You research the HTTP APIs the task depends on and report what the team needs to use them correctly.',
      "- Find the API: the project's APIs (oxy_project_resources lists them; call them with oxy_api_describe and oxy_api_request, which add the credentials) or a URL or document named in the brief or by the teammate who asked.",
      '- Read the OpenAPI/Swagger document when there is one, then confirm the real behaviour with safe requests (GET, HEAD). Never call endpoints that create, change or delete data unless the brief explicitly allows it.',
      '- Report only the endpoints the task needs: method and path, purpose, parameters, authentication, request and response shapes (as TypeScript types plus a trimmed JSON example), status codes and errors, pagination and limits, and anything surprising.',
      '- Keep what you verified with a request apart from what only the documentation says. You do not edit files.',
    ].join('\n'),
  },
  {
    preset: 'docs',
    label: 'Docs writer',
    color: 'pink',
    name: 'Ken',
    cli: 'claude-code',
    model: 'claude-haiku-5-5',
    effort: 'medium',
    readOnly: false,
    permissionMode: 'acceptEdits',
    hint: 'Updates README, docs and changelog',
    rolePrompt:
      'You write documentation for a change: the README, docs and changelog, in the style and language the project already uses. Change only what the change makes outdated and what users and developers need to know. Be brief and concrete.',
  },
  {
    preset: 'advisor',
    label: 'Advisor',
    color: 'teal',
    name: 'Fable',
    cli: 'claude-code',
    model: 'claude-fable-5-1',
    effort: 'high',
    readOnly: true,
    permissionMode: 'default',
    hint: 'On call at a few moments, never writes code',
    rolePrompt:
      'You are a senior advisor on call. You are consulted only at a few moments; answer in a few sentences with the one or two things that matter most. Say "no concerns" when there are none. You never write code.',
  },
  {
    preset: 'custom',
    label: 'Agent',
    color: 'red',
    name: 'Alan',
    cli: 'claude-code',
    model: '',
    effort: '',
    readOnly: false,
    permissionMode: 'default',
    hint: 'Your own role',
    rolePrompt: '',
  },
];

export function rolePreset(preset: RolePreset): RolePresetDefinition {
  return ROLE_PRESETS.find((p) => p.preset === preset) ?? ROLE_PRESETS.at(-1)!;
}

/** A short id from a name ("Grace Hopper" → "grace-hopper"), unique among `taken`. */
export function slugId(name: string, taken: Iterable<string> = [], fallback = 'item'): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base.slice(0, 28)}-${i}`;
    if (!used.has(id)) return id;
  }
}

/** A new agent from a preset (names stay unique in the team). */
export function agentFromPreset(preset: RolePreset, team: readonly EnsembleAgent[], cli?: EnsembleCli): EnsembleAgent {
  const p = rolePreset(preset);
  const names = new Set(team.map((a) => a.name.toLowerCase()));
  let name = p.name;
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${p.name} ${i}`;
  const chosenCli = cli ?? p.cli;
  return {
    id: slugId(
      name,
      team.map((a) => a.id),
      'agent',
    ),
    name,
    role: { preset: p.preset, label: p.label, color: p.color },
    cli: chosenCli,
    ...(chosenCli === 'claude-code' && p.model ? { model: p.model } : {}),
    ...(chosenCli === 'claude-code' && p.effort ? { effort: p.effort } : {}),
    permissionMode: p.permissionMode,
    readOnly: p.readOnly,
    rolePrompt: p.rolePrompt,
    extraArgs: [],
    env: {},
  };
}

// ── templates ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TaskTemplate {
  id: string;
  title: string;
  description: string;
  /** Stage titles for the card's mini pipeline. */
  shape: string[];
  build(): Pick<EnsembleTask, 'agents' | 'pipeline' | 'advisor'> & {
    generalPrompt?: string;
    /** Read-only templates work in the current checkout (they review what is there). */
    workspaceMode?: EnsembleTask['workspace']['mode'];
  };
}

const stage = <S extends Stage>(s: Omit<S, 'instruction'> & { instruction?: string }): S =>
  ({ instruction: '', ...s }) as S;

function team(...presets: (RolePreset | [RolePreset, EnsembleCli])[]): EnsembleAgent[] {
  const out: EnsembleAgent[] = [];
  for (const p of presets) out.push(Array.isArray(p) ? agentFromPreset(p[0], out, p[1]) : agentFromPreset(p, out));
  return out;
}

export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: 'feature',
    title: 'Feature',
    description: 'Plan, approve, implement ⇄ review, run the tests, approve.',
    shape: ['Plan', 'Approve', 'Implement ⇄ Review', 'Tests', 'Approve'],
    build() {
      const [planner, implementer, reviewer] = team('planner', 'implementer', 'reviewer');
      return {
        agents: [planner!, implementer!, reviewer!],
        pipeline: [
          stage({
            id: 'plan',
            kind: 'agent',
            title: 'Plan',
            agentId: planner!.id,
            output: 'plan',
            freshSession: false,
          }),
          stage({
            id: 'approve-plan',
            kind: 'gate',
            title: 'Approve the plan',
            show: ['plan'],
            onReject: 'back-to-previous',
          }),
          stage({
            id: 'implement',
            kind: 'loop',
            title: 'Implement ⇄ Review',
            workerId: implementer!.id,
            checkerId: reviewer!.id,
            maxRounds: 3,
            checkerInstruction: '',
          }),
          stage({
            id: 'tests',
            kind: 'command',
            title: 'Tests',
            command: 'npm test',
            onFail: { agentId: implementer!.id, maxAttempts: 2 },
          }),
          stage({
            id: 'approve',
            kind: 'gate',
            title: 'Approve the result',
            show: ['diff', 'review', 'summary'],
            onReject: 'back-to-previous',
          }),
        ],
      };
    },
  },
  {
    id: 'bugfix',
    title: 'Bugfix',
    description: 'Reproduce with a failing test, fix ⇄ review, approve.',
    shape: ['Reproduce', 'Fix ⇄ Review', 'Approve'],
    build() {
      const [tester, implementer, reviewer] = team('tester', 'implementer', 'reviewer');
      return {
        agents: [tester!, implementer!, reviewer!],
        pipeline: [
          stage({
            id: 'reproduce',
            kind: 'agent',
            title: 'Reproduce',
            agentId: tester!.id,
            output: 'test-report',
            freshSession: false,
            instruction:
              'Reproduce the bug described in the brief with a failing automated test. Do not fix the bug. Submit with kind "test-report": the test you added, how it fails and what you found about the cause.',
          }),
          stage({
            id: 'fix',
            kind: 'loop',
            title: 'Fix ⇄ Review',
            workerId: implementer!.id,
            checkerId: reviewer!.id,
            maxRounds: 3,
            checkerInstruction: '',
            instruction:
              'Fix the bug. Make the failing test from the reproduce stage (its report is in the results) pass without weakening it, and run the related tests. Submit with kind "implementation".',
          }),
          stage({
            id: 'approve',
            kind: 'gate',
            title: 'Approve the fix',
            show: ['diff', 'review'],
            onReject: 'back-to-previous',
          }),
        ],
      };
    },
  },
  {
    id: 'review',
    title: 'Review only',
    description: 'Two reviewers with different lenses read the current branch.',
    shape: ['Review ×2', 'Approve'],
    build() {
      const [a, b] = team('reviewer', 'reviewer');
      b!.name = 'Bruce';
      b!.id = slugId('Bruce', [a!.id]);
      b!.role = { ...b!.role, label: 'Security reviewer', color: 'red' };
      b!.rolePrompt =
        'You review for security: injection, authentication and authorization, secrets, unsafe input handling, dependency risks. Report concrete findings with file and line. You do not edit files.';
      return {
        agents: [a!, b!],
        workspaceMode: 'current-checkout',
        pipeline: [
          stage({
            id: 'review',
            kind: 'parallel',
            title: 'Review',
            agentIds: [a!.id, b!.id],
            output: 'review',
            join: 'all',
            instruction:
              'Review the work in this folder: the uncommitted changes (`git status`, `git diff`) and the commits of this branch that are not on the default branch (`git log`, `git diff <default branch>...HEAD`), or what the brief names. Submit with kind "review", a verdict and findings (file, line, severity, message).',
          }),
          stage({ id: 'read', kind: 'gate', title: 'Read the reviews', show: ['review'], onReject: 'stop' }),
        ],
      };
    },
  },
  {
    id: 'research',
    title: 'Research spike',
    description: 'A researcher investigates, the planner turns it into a plan.',
    shape: ['Research', 'Plan', 'Approve'],
    build() {
      const [researcher, planner] = team('researcher', 'planner');
      return {
        agents: [researcher!, planner!],
        pipeline: [
          stage({
            id: 'research',
            kind: 'agent',
            title: 'Research',
            agentId: researcher!.id,
            output: 'research',
            freshSession: false,
          }),
          stage({
            id: 'plan',
            kind: 'agent',
            title: 'Plan',
            agentId: planner!.id,
            output: 'plan',
            freshSession: false,
            instruction:
              'Turn the research (in the results) into a recommendation and a plan: the option you recommend and why, what to build, the steps, risks and open questions. Submit with kind "plan".',
          }),
          stage({ id: 'approve', kind: 'gate', title: 'Read the plan', show: ['plan'], onReject: 'back-to-previous' }),
        ],
      };
    },
  },
  {
    id: 'refactor',
    title: 'Refactor with tests',
    description: 'Tests first, then refactor ⇄ review, run the tests.',
    shape: ['Tests', 'Refactor ⇄ Review', 'Tests'],
    build() {
      const [tester, implementer, reviewer] = team('tester', 'implementer', 'reviewer');
      return {
        agents: [tester!, implementer!, reviewer!],
        pipeline: [
          stage({
            id: 'cover',
            kind: 'agent',
            title: 'Cover with tests',
            agentId: tester!.id,
            output: 'test-report',
            freshSession: false,
            instruction:
              'Before anything changes, make sure the code to refactor is covered by tests that pin its current behavior. Add the missing ones and run them. Submit with kind "test-report".',
          }),
          stage({
            id: 'refactor',
            kind: 'loop',
            title: 'Refactor ⇄ Review',
            workerId: implementer!.id,
            checkerId: reviewer!.id,
            maxRounds: 3,
            checkerInstruction: '',
            instruction:
              'Refactor as the brief asks without changing behavior. The tests from the previous stage must keep passing. Submit with kind "implementation".',
          }),
          stage({
            id: 'tests',
            kind: 'command',
            title: 'Tests',
            command: 'npm test',
            onFail: { agentId: implementer!.id, maxAttempts: 2 },
          }),
        ],
      };
    },
  },
  {
    id: 'second-opinion',
    title: 'Second opinion',
    description: 'Claude implements, Codex reviews: a second vendor checks the work.',
    shape: ['Implement ⇄ Review (Codex)', 'Approve'],
    build() {
      const [implementer, reviewer] = team('implementer', ['reviewer', 'codex']);
      reviewer!.name = 'Ken';
      reviewer!.id = slugId('Ken', [implementer!.id]);
      reviewer!.role = { ...reviewer!.role, label: 'Second opinion' };
      return {
        agents: [implementer!, reviewer!],
        pipeline: [
          stage({
            id: 'implement',
            kind: 'loop',
            title: 'Implement ⇄ Review',
            workerId: implementer!.id,
            checkerId: reviewer!.id,
            maxRounds: 3,
            checkerInstruction: '',
          }),
          stage({
            id: 'approve',
            kind: 'gate',
            title: 'Approve',
            show: ['diff', 'review'],
            onReject: 'back-to-previous',
          }),
        ],
      };
    },
  },
  {
    id: 'blank',
    title: 'Blank',
    description: 'One implementer; build your own team and pipeline.',
    shape: ['Implement'],
    build() {
      const [implementer] = team('implementer');
      return {
        agents: [implementer!],
        pipeline: [
          stage({
            id: 'implement',
            kind: 'agent',
            title: 'Implement',
            agentId: implementer!.id,
            output: 'implementation',
            freshSession: false,
          }),
        ],
      };
    },
  },
];

/** A new draft task from a template. */
export function taskFromTemplate(
  templateId: string,
  o: { id: string; projectId: string; title?: string; description?: string; now: number },
): EnsembleTask {
  const template = TASK_TEMPLATES.find((t) => t.id === templateId) ?? TASK_TEMPLATES.at(-1)!;
  const built = template.build();
  return {
    v: 1,
    id: o.id,
    projectId: o.projectId,
    title: o.title?.trim() || `New ${template.title.toLowerCase()} task`,
    description: o.description ?? '',
    generalPrompt: built.generalPrompt ?? '',
    attachments: [],
    workspace: { mode: built.workspaceMode ?? 'worktree', setupCommands: [], copyFiles: [] },
    agents: built.agents,
    pipeline: built.pipeline,
    ...(built.advisor ? { advisor: built.advisor } : {}),
    limits: { maxConcurrentAgents: 3 },
    createdAt: o.now,
    updatedAt: o.now,
    templateId: template.id,
  };
}

/** A new stage of a kind with sensible defaults (the builder's "Add stage" menu). */
export function newStage(kind: Stage['kind'], task: Pick<EnsembleTask, 'agents' | 'pipeline'>): Stage {
  const ids = task.pipeline.map((s) => s.id);
  const writer = task.agents.find((a) => !a.readOnly) ?? task.agents[0];
  const reader =
    task.agents.find((a) => a.readOnly && a.id !== writer?.id) ?? task.agents.find((a) => a.id !== writer?.id);
  const first = task.agents[0]?.id ?? '';
  switch (kind) {
    case 'agent':
      return {
        id: slugId('step', ids),
        kind,
        title: 'Agent step',
        instruction: '',
        agentId: writer?.id ?? first,
        output: 'implementation',
        freshSession: false,
      };
    case 'parallel': {
      const readers = task.agents.filter((a) => a.readOnly).map((a) => a.id);
      return {
        id: slugId('parallel', ids),
        kind,
        title: 'Parallel',
        instruction: '',
        agentIds: readers.length >= 2 ? readers.slice(0, 3) : task.agents.slice(0, 2).map((a) => a.id),
        output: 'review',
        join: 'all',
      };
    }
    case 'loop':
      return {
        id: slugId('loop', ids),
        kind,
        title: 'Implement ⇄ Review',
        instruction: '',
        workerId: writer?.id ?? first,
        checkerId: reader?.id ?? first,
        maxRounds: 3,
        checkerInstruction: '',
      };
    case 'gate':
      return {
        id: slugId('gate', ids),
        kind,
        title: 'Approve',
        instruction: '',
        show: ['summary'],
        onReject: 'back-to-previous',
      };
    case 'command':
      return {
        id: slugId('command', ids),
        kind,
        title: 'Tests',
        instruction: '',
        command: 'npm test',
        onFail: { ...(writer ? { agentId: writer.id } : {}), maxAttempts: 2 },
      };
  }
}

// ── lead & crew ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A title from the first line of a prompt ("Add CSV export to the reports page"). */
export function titleFromPrompt(prompt: string): string {
  const line =
    prompt
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find(Boolean) ?? '';
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return sentence.length > 60 ? `${sentence.slice(0, 57).trimEnd()}…` : sentence.replace(/[.!?]$/, '');
}

/** The crew offered until the user sets up their own: a lead and five teammates. */
export function defaultCrew(): EnsembleCrew {
  const members = team('lead', 'implementer', 'reviewer', 'researcher', 'api-researcher', 'tester');
  return { leadId: members[0]!.id, members, maxConcurrentAgents: 4 };
}

/** The crew of the `ensemble.crew` setting (the default crew when it is empty or invalid); the lead always exists. */
export function crewOf(value: unknown): EnsembleCrew {
  const parsed = value == null ? null : EnsembleCrewSchema.safeParse(value);
  const crew = parsed?.success ? parsed.data : defaultCrew();
  return crew.members.some((m) => m.id === crew.leadId) ? crew : { ...crew, leadId: crew.members[0]!.id };
}

const memberLine = (a: EnsembleAgent): string => {
  const model = a.model || `${CLI_INFO[a.cli].displayName} default model`;
  const cli = a.cli === 'claude-code' ? '' : `${CLI_INFO[a.cli].displayName}, `;
  const hint = a.role.preset === 'custom' ? '' : ` · ${rolePreset(a.role.preset).hint.toLowerCase()}`;
  return `- ${a.name} (${a.role.label}) — ${cli}${model}${a.effort ? `, effort ${a.effort}` : ''} · ${a.readOnly ? 'read-only' : 'edits files'}${hint}`;
};

/**
 * The lead's instruction: the crew with its models, when delegating pays off and how to write a delegation. Multi-agent
 * work costs several times the tokens of one session and every teammate starts with an empty context, so the lead
 * keeps the work that needs what it already knows and hands out only well-defined, self-contained pieces.
 */
export function crewLeadInstruction(
  lead: EnsembleAgent,
  crew: readonly EnsembleAgent[],
  maxConcurrent: number,
): string {
  const others = crew.filter((a) => a.id !== lead.id);
  if (!others.length)
    return [
      'You have no crew for this task: do the work yourself.',
      'When the work is done and checked, submit with kind "implementation": what was done, the files changed, how you checked it, and anything the user must know or decide.',
    ].join('\n');
  return [
    'You lead this task. You can do any of the work yourself, and you have a crew of AI agents, each in its own terminal; a teammate starts only when you hand it work.',
    '',
    'Your crew:',
    ...others.map(memberLine),
    '',
    'The crew is there to finish the task sooner and cheaper than you would alone. You are the most capable model here, so spend your effort on understanding the task, deciding and checking, and hand well-defined work to the teammates. Delegation has a cost too: a teammate starts with an empty context and has to rebuild whatever you know but did not write down.',
    '',
    'Delegate:',
    '- self-contained work you can describe precisely: a module or a set of files whose design you settled, tests for a known behaviour, a documentation update;',
    '- work that would fill your context with material you will not need again: exploring an unfamiliar part of the code, reading API documentation, running a slow test suite and reporting the failures;',
    '- one review of the finished change with fresh eyes, before you finish (not after every small fix);',
    '- independent pieces at the same time: they run in parallel.',
    '',
    'Do it yourself:',
    '- anything you can finish in a handful of tool calls, or that would take longer to explain than to do;',
    '- steps that depend on what you just learned, and small fixes after a review or a failing check;',
    "- never delegate the same thing twice and never redo a teammate's work: check its result instead.",
    '',
    'How to delegate (oxy_ensemble_delegate, `to`: the name): the teammate sees only your text, with the task as background, so write a self-contained brief:',
    '1. Goal: what to achieve and why.',
    '2. Context: the files, functions and decisions it needs — what you already found out, so it does not explore again.',
    '3. Scope: the files it may change and what to leave alone. Teammates who edit files share one folder: never give two of them overlapping files at the same time.',
    '4. Done when: the check that proves it (the test or command to run).',
    '5. Report: what you need back.',
    'Each delegation starts the teammate in a fresh session. Pass `same_session: true` only to continue work it just did (e.g. fixing review findings in its own change), when what it learned helps.',
    '',
    `At most ${maxConcurrent} agents work at the same time (you included); further work waits in a queue. Reports arrive as messages: meanwhile work on what does not depend on them, or end your turn and wait — they wake you.`,
    '',
    'Finish: when the work is done and checked (the checks you can run pass), submit with kind "implementation": what was done and by whom, the files changed, how it was checked, and anything the user must know or decide. Keep it short.',
  ].join('\n');
}

/**
 * "Lead & crew": one prompt; the lead gets the task and decides who does what among the members picked for it
 * (`memberIds`, default: the whole crew), optionally followed by a test command (failures go back to the lead) and
 * the user's approval.
 */
export function crewTask(o: {
  id: string;
  projectId: string;
  prompt: string;
  title?: string | undefined;
  crew: EnsembleCrew;
  /** Members this task may use (the lead always). */
  memberIds?: readonly string[] | undefined;
  testCommand?: string | undefined;
  approveResult: boolean;
  now: number;
}): EnsembleTask {
  const crew = crewOf(o.crew);
  const picked = o.memberIds ? new Set(o.memberIds) : undefined;
  const agents = structuredClone(crew.members).filter((a) => !picked || picked.has(a.id) || a.id === crew.leadId);
  const lead = agents.find((a) => a.id === crew.leadId)!;
  const pipeline: Stage[] = [
    stage({
      id: 'lead',
      kind: 'agent',
      title: 'Lead the crew',
      instruction: crewLeadInstruction(lead, agents, crew.maxConcurrentAgents),
      agentId: lead.id,
      output: 'implementation',
      freshSession: false,
    }),
  ];
  const command = o.testCommand?.trim();
  if (command)
    pipeline.push(
      stage({
        id: 'run-tests',
        kind: 'command',
        title: 'Run the tests',
        command,
        onFail: { agentId: lead.id, maxAttempts: 2 },
      }),
    );
  if (o.approveResult)
    pipeline.push(
      stage({
        id: 'approve',
        kind: 'gate',
        title: 'Approve the result',
        show: ['diff', 'summary'],
        onReject: 'back-to-previous',
      }),
    );
  return {
    v: 1,
    id: o.id,
    projectId: o.projectId,
    title: o.title?.trim() || titleFromPrompt(o.prompt) || 'New task',
    description: o.prompt.trim(),
    generalPrompt: '',
    attachments: [],
    workspace: {
      mode: agents.some((a) => !a.readOnly) ? 'worktree' : 'current-checkout',
      setupCommands: [],
      copyFiles: [],
    },
    agents,
    pipeline,
    limits: { maxConcurrentAgents: crew.maxConcurrentAgents },
    createdAt: o.now,
    updatedAt: o.now,
    templateId: 'crew',
    leadId: lead.id,
  };
}
