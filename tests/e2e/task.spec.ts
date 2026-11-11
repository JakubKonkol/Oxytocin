import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import type { AgentSnapshot, AgentLaunchResult } from '@oxytocin/plugin-api';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
const fakeCodex = join(repoRoot, 'tests/fixtures/agents/node_modules/@openai/codex/bin/codex.js');

/** A project with a git repository and the fake Claude Code and Codex CLI as its AI agents. */
async function setup(name: string, env: Record<string, string> = {}) {
  // The long path: on Windows the temp folder can be an 8.3 short name (RUNNER~1), the app shows the long one.
  const root = await realpath(await mkdtemp(join(tmpdir(), `oxy-e2e-${name}-`)));
  const repo = join(root, 'repo');
  const userData = join(root, 'data');
  const claudeHome = join(root, 'claude');
  await mkdir(repo);
  await mkdir(userData);
  await mkdir(claudeHome);
  const git = (...args: string[]) =>
    execFileSync('git', ['--no-optional-locks', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'test.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  await writeFile(join(repo, 'test.txt'), 'after\n');
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'usage.pricing.autoUpdate': false,
      'aiAgents.commands': { claude: `node "${fakeClaude}"`, codex: `node "${fakeCodex}" --status` },
    }),
  );
  await writeFile(
    join(userData, 'ai-agents.json'),
    JSON.stringify({
      version: 1,
      detectedAt: Date.now(),
      agents: [
        { id: 'claude', name: 'Claude Code', command: 'claude', category: 'agent', accounts: [] },
        { id: 'codex', name: 'Codex CLI', command: 'codex', category: 'agent', accounts: [] },
      ],
    }),
  );
  const launched = await launchApp({ project: repo, userData, env: { CLAUDE_CONFIG_DIR: claudeHome, ...env } });
  return { ...launched, root, repo, claudeHome };
}

async function taskFrame(win: Page): Promise<Frame> {
  await win.evaluate(() => window.oxy.invoke('plugins:executeCommand', { id: 'task.show' }));
  await expect(win.getByTestId('secondary-sidebar').getByTestId('sidebar-tool-task.panel')).toBeVisible();
  return currentFrame(win);
}

async function currentFrame(win: Page): Promise<Frame> {
  let frame: Frame | undefined;
  await expect
    .poll(
      () =>
        (frame = win
          .frames()
          .find((f) => f.url().startsWith('oxy-plugin://oxytocin.task/dist/views/task.html') && !f.isDetached())),
    )
    .toBeTruthy();
  return frame!;
}

/** A plan with Task's outline, as the planning skill asks for it (" | " in a step list is a new step). */
const planDocument = (steps: string[]) =>
  [
    '# Search plan',
    '',
    '## Summary',
    'Adds a search field.',
    '',
    '## Steps',
    '',
    ...steps.flatMap((step, i) => [`### [ ] ${i + 1}. ${step}`, 'Files: `test.txt`', '', 'Do it.', '']),
    '## Verification',
    '- [ ] `npm test`',
    '',
  ].join('\n');

/** The folder of the project's only task (`.oxy/tasks/<id>`), once Task created it. */
async function taskFolder(repo: string): Promise<string> {
  const tasks = join(repo, '.oxy', 'tasks');
  let id: string | undefined;
  await expect
    .poll(async () => (id = (await readdir(tasks).catch(() => [])).find((entry) => /^[0-9a-f-]{36}$/.test(entry))))
    .toBeTruthy();
  return join(tasks, id!);
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const agents = async (win: Page) => (await win.evaluate(() => window.oxy.invoke('agents:list'))) as AgentSnapshot[];

/** The terminal of the n-th agent of a kind (in the order they started). */
async function agentTerminal(win: Page, agentId: string, index = 0): Promise<string> {
  let id = '';
  await expect
    .poll(async () => (id = (await agents(win)).filter((a) => a.agentId === agentId)[index]?.terminalId ?? ''), {
      timeout: 20_000,
    })
    .not.toBe('');
  return id;
}

/** Types a line into an agent's terminal once the agent waits for input (clicked first, for the keyboard focus). */
async function typeInto(win: Page, terminalId: string, line: string) {
  await expect
    .poll(async () => (await agents(win)).find((a) => a.terminalId === terminalId)?.state, { timeout: 15_000 })
    .toBe('idle');
  await win.getByTestId(`terminal-view-${terminalId}`).click();
  await run(win, line);
}

test('Task: the planner writes a structured plan file, feedback revises it, Codex implements it with progress and the files leave the project', async () => {
  test.setTimeout(120_000);
  const { app, win, repo } = await setup('task');
  try {
    await waitForTerminal(win);
    const frame = await taskFrame(win);
    await frame.getByTestId('task-description').fill('Add a search field');
    await frame.getByTestId('task-planner').selectOption('ai:claude');
    await frame.getByTestId('task-implementer').selectOption('ai:codex');
    await frame.getByTestId('task-reviewer').selectOption('ai:claude');
    await frame.getByTestId('task-start').click();

    // A fresh session that starts with a one-line prompt naming the task's files; only Task's settings are added.
    const planner = await agentTerminal(win, 'claude-code');
    await expect.poll(() => oxyTest(win).text(planner)).toContain('PROMPT: Plan a task for Oxytocin');
    const started = await oxyTest(win).text(planner);
    expect(started).toMatch(/ARGS: Plan a task for Oxytocin; .* --settings \S+claude-planner-settings\.json\s*$/m);
    for (const absent of ['--add-dir', '--permission-mode', '--model', 'UNSUBMITTED PROMPT'])
      expect(started).not.toContain(absent);
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(planner);

    // The task's files are in the project's .oxy/tasks folder, which Git ignores.
    const folder = await taskFolder(repo);
    const planFile = join(folder, 'plan.md');
    expect(JSON.parse(await readFile(join(folder, 'raw.task.json'), 'utf8'))).toMatchObject({
      description: 'Add a search field',
    });
    expect(await readFile(join(repo, '.oxy', 'tasks', 'skills', 'plan.md'), 'utf8')).toContain('## Format');
    expect(started).toContain(planFile);
    const status = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(status).not.toContain('.oxy');
    await expect(frame.getByTestId('task-plan-file')).toHaveText(planFile);

    // The planner writes the plan file: Task shows it as steps, not as plain Markdown.
    await writeFile(planFile, planDocument(['Add the field', 'Test it']));
    await expect(frame.getByTestId('task-plan-status')).toHaveText('Plan awaiting approval', { timeout: 15_000 });
    const plan = frame.getByTestId('task-plan-view');
    await expect(plan).toHaveAttribute('data-structured', 'true');
    await expect(plan.locator('h1')).toHaveText('Search plan');
    await expect(plan.getByTestId('task-step')).toHaveCount(2);
    await expect(plan.getByTestId('task-step').first()).toContainText('Add the field');
    await expect(plan.getByTestId('task-step').first().locator('.plan-files code')).toHaveText('test.txt');
    await expect(plan.getByTestId('task-check')).toHaveCount(1);
    await win.screenshot({ path: test.info().outputPath('task-plan.png') });

    // Feedback is typed into the planner's session; the rewritten file is the next version.
    await frame.getByTestId('task-feedback').fill('Also handle an empty query.');
    await frame.getByTestId('task-revise').click();
    await expect
      .poll(() => oxyTest(win).text(planner))
      .toMatch(/PROMPT: The user reviewed your plan[\s\S]*Also handle an empty query\./);
    await expect(frame.getByTestId('task-plan-status')).toHaveText('The planner is revising the plan');
    await writeFile(planFile, planDocument(['Add the field', 'Handle an empty query', 'Test it']));
    await taskFrame(win);
    await expect(plan.getByTestId('task-step')).toHaveCount(3, { timeout: 15_000 });
    await frame.getByTestId('task-versions').locator('summary').click();
    await expect(frame.getByTestId('task-versions').locator('li')).toHaveCount(2);
    await expect(frame.getByTestId('task-versions').locator('li').first()).toContainText('feedback sent');
    await expect(frame.getByTestId('task-versions').locator('blockquote')).toHaveText('Also handle an empty query.');

    // Approval starts a fresh Codex session that is pointed at the plan file and its skill.
    await frame.getByTestId('task-approve').click();
    const codex = await agentTerminal(win, 'codex');
    await expect.poll(() => oxyTest(win).text(codex)).toContain('PROMPT: Implement the user-approved plan in');
    expect(await oxyTest(win).text(codex)).toMatch(/plan\.md[\s\S]*implement\.md/);
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(codex);
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan-status')).toHaveText('Plan approved');
    await expect(frame.getByTestId('task-delivery')).toHaveCount(0);
    await expect(frame.getByTestId('task-progress')).toContainText('0 of 3 done');

    // The implementer ticks a step in the plan file: Task shows the progress.
    const approved = await readFile(planFile, 'utf8');
    await writeFile(planFile, approved.replace('### [ ] 1.', '### [x] 1.'));
    await expect(frame.getByTestId('task-progress')).toContainText('1 of 3 done', { timeout: 15_000 });
    await expect(plan.getByTestId('task-step').first()).toHaveAttribute('data-done', 'true');
    await expect(plan.getByTestId('task-step').nth(1)).toHaveAttribute('data-done', 'false');

    await frame.getByTestId('task-review').click();
    const reviewer = await agentTerminal(win, 'claude-code', 1);
    await expect.poll(() => oxyTest(win).text(reviewer)).toContain('PROMPT: Review the current changes');
    expect(await oxyTest(win).text(reviewer)).toMatch(/--settings \S+claude-reviewer-settings\.json\s*$/m);
    await taskFrame(win);

    // Done: the plan and its progress stay in Task, nothing of the task stays in the project.
    await frame.getByTestId('task-done').click();
    await expect(frame.getByText('COMPLETED', { exact: true })).toBeVisible();
    await expect(frame.getByTestId('task-progress')).toContainText('1 of 3 done');
    await expect(frame.getByTestId('task-plan-file')).toHaveCount(0);
    await expect.poll(() => exists(join(repo, '.oxy'))).toBe(false);
  } finally {
    await app.close();
  }
});

test('Task types into chosen sessions once they are ready, follows the project when moved, and Changes reuses an idle agent', async () => {
  test.setTimeout(120_000);
  const { app, win, root, repo } = await setup('task-sessions');
  try {
    await waitForTerminal(win);
    const projectId = await win.evaluate(
      async () => ((await window.oxy.invoke('projects:list')) as { id: string }[])[0]!.id,
    );
    const launch = (launchId: string) =>
      win.evaluate(([projectId, launchId]) => window.oxy.invoke('aiAgents:launch', { projectId, launchId }), [
        projectId,
        launchId,
      ] as const) as Promise<AgentLaunchResult>;
    const planner = (await launch('ai:claude')).terminalId;
    const implementer = (await launch('ai:codex')).terminalId;
    for (const id of [planner, implementer])
      await expect.poll(async () => (await agents(win)).find((a) => a.terminalId === id)?.state).toBe('idle');
    // The implementer is in the middle of a turn when the plan is approved.
    await typeInto(win, implementer, 'work');
    await expect.poll(async () => (await agents(win)).find((a) => a.terminalId === implementer)?.state).toBe('working');

    const frame = await taskFrame(win);
    await frame.getByTestId('task-description').fill('Improve the search field');
    await frame.getByTestId('task-planner').selectOption('ai:claude');
    await frame.getByLabel('Planner session').selectOption(planner);
    await frame.getByTestId('task-implementer').selectOption('ai:codex');
    await frame.getByLabel('Implementer session').selectOption(implementer);
    await frame.getByTestId('task-start').click();
    // A chosen idle session has the prompt typed; its plan file is taken like any other planner's.
    await expect.poll(() => oxyTest(win).text(planner)).toContain('PROMPT: Plan a task for Oxytocin');
    await writeFile(join(await taskFolder(repo), 'plan.md'), planDocument(['Add a keyboard shortcut', 'Test it']));
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan-view')).toContainText('Add a keyboard shortcut', { timeout: 15_000 });
    await frame.getByTestId('task-approve').click();

    // The busy implementer gets the plan as soon as its turn ends: no error, no retry.
    await expect(frame.getByTestId('task-delivery')).toContainText('finishing its current turn');
    await expect(frame.getByRole('alert')).toHaveCount(0);
    expect(await oxyTest(win).text(implementer)).not.toContain('Implement the user-approved plan');
    // Its turn ends (typed while it works, like a user would).
    await win.getByTestId(`terminal-view-${implementer}`).click();
    await run(win, 'done');
    await expect
      .poll(() => oxyTest(win).text(implementer), { timeout: 20_000 })
      .toContain('Implement the user-approved plan');
    await taskFrame(win);
    await expect(frame.getByTestId('task-delivery')).toHaveCount(0);
    await expect(frame.getByTestId('task-plan-status')).toHaveText('Plan approved');
    // No session was opened for the chosen roles.
    expect((await agents(win)).length).toBe(2);

    // Moving Task keeps the task; in a sidebar it follows the active project.
    const tools = async () =>
      (await win.evaluate(() => window.oxy.invoke('ui:getState'))) as {
        primaryTools: { id: string; panelType?: string }[];
        secondaryTools: { id: string; panelType?: string }[];
      };
    let toolId = '';
    await expect
      .poll(async () => (toolId = (await tools()).secondaryTools.find((t) => t.panelType === 'task.panel')?.id ?? ''))
      .not.toBe('');
    await win.getByTestId(`section-header-${toolId}`).hover();
    await win.getByTestId(`move-tool-side-${toolId}`).click();
    await expect(win.getByTestId('sidebar').getByTestId('sidebar-tool-task.panel')).toBeVisible();
    let moved = await currentFrame(win);
    await expect(moved.getByTestId('task-plan-status')).toHaveText('Plan approved');
    const otherRepo = join(root, 'second-project');
    await mkdir(otherRepo);
    execFileSync('git', ['--no-optional-locks', 'init', '-q'], { cwd: otherRepo });
    await win.evaluate((path) => window.oxy.invoke('projects:add', { path }), otherRepo);
    await win.getByTestId('sidebar').getByText('second-project', { exact: true }).first().click();
    await expect(moved.locator('.toolbar .eyebrow')).toContainText('second-project');
    await expect(moved.getByTestId('task-description')).toBeVisible();
    await expect(moved.getByLabel('Saved task')).toHaveCount(0);
    await win.evaluate((id) => window.oxy.invoke('projects:setActive', { id }), projectId);
    await expect(moved.locator('.toolbar .eyebrow')).toContainText('repo');
    await expect(moved.getByTestId('task-plan-status')).toHaveText('Plan approved');
    await expect
      .poll(async () => (toolId = (await tools()).primaryTools.find((t) => t.panelType === 'task.panel')?.id ?? ''))
      .not.toBe('');
    await win.getByTestId(`section-header-${toolId}`).hover();
    await win.getByTestId(`move-tool-${toolId}`).click();
    await expect(win.getByTestId('plugin-panel-task.panel')).toBeVisible();
    await win.evaluate(() => window.oxy.invoke('plugins:executeCommand', { id: 'task.show' }));
    await expect(win.getByTestId('sidebar-tool-task.panel')).toHaveCount(0);
    await expect(win.getByTestId('plugin-panel-task.panel')).toHaveCount(1);
    moved = await currentFrame(win);
    await expect(moved.getByTestId('task-plan-status')).toHaveText('Plan approved');

    // Changes uses the same picker and the existing idle Codex terminal, with an editable default prompt.
    await expect
      .poll(async () => (await agents(win)).find((a) => a.terminalId === implementer)?.state, { timeout: 15_000 })
      .toBe('idle');
    await expect(win.getByTestId('changes-send-review')).toBeEnabled();
    await win.getByTestId('changes-send-review').click();
    await win.getByTestId('changes-review-agent').selectOption('ai:codex');
    await win.getByRole('button', { name: 'Review instruction', exact: true }).click();
    await win
      .getByTestId('changes-review-prompt')
      .fill('Review the uncommitted changes. List bugs. Do not edit files.');
    await win.getByRole('button', { name: 'Save as default', exact: true }).click();
    const count = (await oxyTest(win).terminalIds()).length;
    await win.getByTestId('changes-send-review-confirm').click();
    await expect(win.getByTestId('changes-send-review-dialog')).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => oxyTest(win).text(implementer)).toContain('List bugs');
    expect((await oxyTest(win).terminalIds()).length).toBe(count);
  } finally {
    await app.close();
  }
});

test('Task points at a new session that does not start on its prompt, until Enter in its terminal starts it', async () => {
  test.setTimeout(120_000);
  // The fake Claude Code leaves its startup prompt in its input box, as Claude Code does with --add-dir.
  const { app, win } = await setup('task-stalled', { FAKE_CLAUDE_UNSUBMITTED: '1' });
  try {
    await waitForTerminal(win);
    const frame = await taskFrame(win);
    await frame.getByTestId('task-description').fill('Add a search field');
    await frame.getByTestId('task-planner').selectOption('ai:claude');
    await frame.getByTestId('task-implementer').selectOption('ai:codex');
    await frame.getByTestId('task-start').click();
    const planner = await agentTerminal(win, 'claude-code');
    await expect.poll(() => oxyTest(win).text(planner)).toContain('UNSUBMITTED PROMPT: Plan a task');
    const stalled = frame.getByTestId('task-stalled');
    // Reported once the session has had its time to start (Task waits 30 s).
    await expect(stalled).toContainText('The planner (Claude Code) has not started on its prompt', {
      timeout: 60_000,
    });
    await stalled.getByRole('button', { name: 'Show terminal' }).click();
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(planner);
    await win.getByTestId(`terminal-view-${planner}`).click();
    await run(win, '');
    await expect.poll(() => oxyTest(win).text(planner)).toContain('PROMPT: Plan a task');
    await expect(stalled).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Task opens once in the right sidebar without a project', async () => {
  const { app, win } = await launchApp({ project: null });
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible({ timeout: 30_000 });
    const frame = await taskFrame(win);
    await expect(frame.getByText('Open a project to plan a task.')).toBeVisible();
    await expect(frame.getByTestId('task-description')).toHaveCount(0);
    await taskFrame(win);
    await expect(win.getByTestId('sidebar-tool-task.panel')).toHaveCount(1);
  } finally {
    await app.close();
  }
});
