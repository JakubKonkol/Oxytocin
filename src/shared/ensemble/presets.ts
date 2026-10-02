import type { EnsembleAgent, EnsembleCli, EnsembleTask, RoleColor, RolePreset, Stage } from '../domain/ensemble';

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
    preset: 'planner',
    label: 'Planner',
    color: 'violet',
    name: 'Ada',
    cli: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    readOnly: true,
    permissionMode: 'default',
    hint: 'Reads the code and writes the plan',
    rolePrompt:
      'You plan before anyone codes. Read the relevant code first, then write a concrete plan: the approach and why, the files to change, the steps in order, edge cases, risks and how to test it. Prefer the simplest design that fits the existing code. You do not edit files.',
  },
  {
    preset: 'implementer',
    label: 'Implementer',
    color: 'blue',
    name: 'Linus',
    cli: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'medium',
    readOnly: false,
    permissionMode: 'acceptEdits',
    hint: 'Writes the code and the tests',
    rolePrompt:
      'You implement. Follow the approved plan and the conventions of the code base, keep the change focused, add or update tests, and run them before you submit. When a reviewer sends findings, fix every one of them or explain why not.',
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
      'You review code changes like a careful senior engineer: correctness first, then missing tests, security, error handling and maintainability. Report concrete findings with file and line; do not nitpick style the linter handles. Approve when the change is correct and complete. You do not edit files.',
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
    hint: 'Writes and runs tests',
    rolePrompt:
      'You make sure the change is tested: write the missing tests (unit first, then integration), run them, and report precisely what passes and fails. Do not change production code unless a test reveals a real bug — then say so.',
  },
  {
    preset: 'researcher',
    label: 'Researcher',
    color: 'sky',
    name: 'Rosalind',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    readOnly: true,
    permissionMode: 'default',
    hint: 'Investigates options, reads docs',
    rolePrompt:
      'You investigate: read the code, the docs and the history, compare options and report findings with evidence (files, lines, links). Separate facts from guesses. You do not edit files.',
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
      'You research HTTP APIs the task depends on and report what the team needs to use them correctly.',
      "- Find the API: the project's APIs (oxy_project_resources lists them; call them with oxy_api_describe and oxy_api_request, which add the credentials) or a URL or document named in the brief or by the teammate who asked.",
      '- Read the OpenAPI/Swagger document when there is one, then confirm the real behaviour with safe requests (GET, HEAD). Never call endpoints that create, change or delete data unless the brief explicitly allows it.',
      '- Report per endpoint: method and path, purpose, parameters (path, query, headers), authentication, request body and response shapes (as TypeScript types plus a trimmed JSON example), status codes and errors, pagination, rate limits and anything surprising.',
      '- Separate what you verified with a request from what only the documentation says. You do not edit files.',
    ].join('\n'),
  },
  {
    preset: 'docs',
    label: 'Docs writer',
    color: 'pink',
    name: 'Ken',
    cli: 'claude-code',
    model: 'claude-sonnet-5-5',
    effort: 'low',
    readOnly: false,
    permissionMode: 'acceptEdits',
    hint: 'Updates README, docs and changelog',
    rolePrompt:
      'You write documentation: update the README, docs and changelog for the change, in the style the project already uses. Be brief and concrete; document what users and developers need to know.',
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
              'Fix the bug. The failing test from the reproduce stage is in oxy_ensemble_context; make it pass without weakening it, and run the related tests. Submit with kind "implementation".',
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
              'Turn the research (in oxy_ensemble_context) into a recommendation and a plan: the option you recommend and why, what to build, the steps, risks and open questions. Submit with kind "plan".',
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

// ── quick start ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Roles the quick start offers next to the planner, who always leads. */
export const QUICK_ROLES = ['implementer', 'reviewer', 'api-researcher', 'researcher', 'tester'] as const;
export type QuickRole = (typeof QUICK_ROLES)[number];

export interface QuickTeam {
  roles: readonly QuickRole[];
  /** A gate after the plan (the default): you read and approve the plan before anyone codes. */
  approvePlan: boolean;
  /** Runs after the implementation; failures go back to the implementer. */
  testCommand?: string | undefined;
}

export const DEFAULT_QUICK_TEAM: QuickTeam = { roles: ['implementer', 'reviewer'], approvePlan: true };

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

/** The planner's instruction when it leads helpers: break the task down, delegate the research, then plan. */
export function leadInstruction(helpers: readonly EnsembleAgent[], builders: readonly EnsembleAgent[]): string {
  const lines = [
    'You lead this task. Read the brief and the relevant code, then break the task down: what must be found out first, and what must be built.',
  ];
  if (helpers.length)
    lines.push(
      '',
      'Delegate what must be found out to your helpers with oxy_ensemble_delegate — in parallel when the questions are independent — and say exactly what you need back:',
      ...helpers.map((h) => `- ${h.name} (${h.role.label}): ${rolePreset(h.role.preset).hint.toLowerCase()}`),
      'Wait for their reports (they arrive as messages), then write the plan on top of them.',
    );
  lines.push(
    '',
    'The plan: the approach and why, the steps in order with the files to change, what each step needs from the research (endpoints, shapes, constraints), edge cases, risks and how to test it.',
  );
  if (builders.length)
    lines.push(
      `Write it for ${builders.map((b) => `${b.name} (${b.role.label})`).join(' and ')}, who carry it out after your plan is approved.`,
    );
  lines.push('Do not change code. Submit the plan with kind "plan" (the full plan in `body`).');
  return lines.join('\n');
}

/**
 * The quick start: one prompt and a team; the pipeline follows from the team. The planner leads (delegating to the
 * researchers), you approve the plan, the implementer builds it (in a loop with the reviewer), the tester and the
 * test command check it.
 */
export function quickTask(o: {
  id: string;
  projectId: string;
  prompt: string;
  title?: string | undefined;
  team: QuickTeam;
  now: number;
}): EnsembleTask {
  const roles = QUICK_ROLES.filter((r) => o.team.roles.includes(r));
  const agents = team('planner', ...roles);
  const [planner] = agents;
  const byRole = (r: QuickRole) => agents.find((a) => a.role.preset === r);
  const implementer = byRole('implementer');
  const reviewer = byRole('reviewer');
  const tester = byRole('tester');
  const helpers = agents.filter((a) => a.role.preset === 'api-researcher' || a.role.preset === 'researcher');
  const builders = [implementer, tester].filter((a): a is EnsembleAgent => !!a);
  const pipeline: Stage[] = [
    stage({
      id: 'plan',
      kind: 'agent',
      title: helpers.length ? 'Plan (with research)' : 'Plan',
      instruction: leadInstruction(helpers, builders),
      agentId: planner!.id,
      output: 'plan',
      freshSession: false,
    }),
  ];
  if (o.team.approvePlan)
    pipeline.push(
      stage({
        id: 'approve-plan',
        kind: 'gate',
        title: 'Approve the plan',
        show: ['plan'],
        onReject: 'back-to-previous',
      }),
    );
  if (implementer)
    pipeline.push(
      reviewer
        ? stage({
            id: 'implement',
            kind: 'loop',
            title: 'Implement ⇄ Review',
            workerId: implementer.id,
            checkerId: reviewer.id,
            maxRounds: 3,
            checkerInstruction: '',
          })
        : stage({
            id: 'implement',
            kind: 'agent',
            title: 'Implement',
            agentId: implementer.id,
            output: 'implementation',
            freshSession: false,
          }),
    );
  else if (reviewer)
    pipeline.push(
      stage({
        id: 'review',
        kind: 'agent',
        title: 'Review',
        agentId: reviewer.id,
        output: 'review',
        freshSession: false,
      }),
    );
  if (tester)
    pipeline.push(
      stage({
        id: 'tests',
        kind: 'agent',
        title: 'Tests',
        agentId: tester.id,
        output: 'test-report',
        freshSession: false,
      }),
    );
  const command = o.team.testCommand?.trim();
  if (command && (implementer ?? tester))
    pipeline.push(
      stage({
        id: 'run-tests',
        kind: 'command',
        title: 'Run the tests',
        command,
        onFail: { agentId: (implementer ?? tester)!.id, maxAttempts: 2 },
      }),
    );
  const writes = agents.some((a) => !a.readOnly);
  return {
    v: 1,
    id: o.id,
    projectId: o.projectId,
    title: o.title?.trim() || titleFromPrompt(o.prompt) || 'New task',
    description: o.prompt.trim(),
    generalPrompt: '',
    attachments: [],
    workspace: { mode: writes ? 'worktree' : 'current-checkout', setupCommands: [], copyFiles: [] },
    agents,
    pipeline,
    limits: { maxConcurrentAgents: 3 },
    createdAt: o.now,
    updatedAt: o.now,
    templateId: 'quick',
  };
}
