import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import type { AgentSnapshot, AgentLaunchResult } from '@oxytocin/plugin-api';
import { launchApp, repoRoot } from './helpers/launch';
import { oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
const fakeCodex = join(repoRoot, 'tests/fixtures/agents/node_modules/@openai/codex/bin/codex.js');

/** A project with a git repository and the fake Claude Code and Codex CLI as its AI agents. */
async function setup(name: string) {
  const root = await mkdtemp(join(tmpdir(), `oxy-e2e-${name}-`));
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
  const launched = await launchApp({ project: repo, userData, env: { CLAUDE_CONFIG_DIR: claudeHome } });
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

test('Task: a Claude planner waits for the decision in Task, feedback revises the plan, Codex implements and Claude reviews', async () => {
  test.setTimeout(120_000);
  const { app, win } = await setup('task');
  try {
    await waitForTerminal(win);
    const frame = await taskFrame(win);
    await frame.getByTestId('task-description').fill('Add a search field');
    await frame.getByTestId('task-planner').selectOption('ai:claude');
    await frame.getByTestId('task-implementer').selectOption('ai:codex');
    await frame.getByTestId('task-reviewer').selectOption('ai:claude');
    await frame.getByTestId('task-start').click();

    // A fresh session that starts with the prompt on its command line: plan mode, bypass available, Task's settings.
    const planner = await agentTerminal(win, 'claude-code');
    await expect.poll(() => oxyTest(win).text(planner)).toContain('PROMPT: Plan this task');
    const started = await oxyTest(win).text(planner);
    expect(started).toContain('Task: Add a search field');
    // The fake parses its command line like Claude Code: nothing after the prompt can swallow it, and no --add-dir
    // keeps it from being submitted (Task's folder is readable through its settings).
    expect(started).toMatch(
      /ARGS: Plan this task; .* --permission-mode plan --model opus --effort high --allow-dangerously-skip-permissions --settings \S+claude-settings\.json\s*$/m,
    );
    expect(started).not.toContain('--add-dir');
    expect(started).not.toContain('UNSUBMITTED PROMPT');
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(planner);

    // Claude finishes the plan and waits in the hook: no question in the terminal, the plan appears in Task.
    await typeInto(win, planner, 'exitplan # Search plan | - Add the field | - Test it');
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan-status')).toHaveText('Plan awaiting approval', { timeout: 15_000 });
    await expect(frame.getByTestId('task-plan-view').locator('h1')).toHaveText('Search plan');
    await expect(frame.getByTestId('task-plan-view').locator('li')).toHaveCount(2);
    await expect(frame.getByText('Claude is waiting for your decision.', { exact: false })).toBeVisible();
    expect(await oxyTest(win).text(planner)).not.toContain('Would you like to proceed?');
    await win.screenshot({ path: test.info().outputPath('task-plan-hook.png') });

    // Feedback is the hook's answer: Claude revises at once, nothing is typed into its terminal.
    await frame.getByTestId('task-feedback').fill('Also handle an empty query.');
    await frame.getByTestId('task-revise').click();
    await expect.poll(() => oxyTest(win).text(planner)).toMatch(/asks for changes[\s\S]*Also handle an empty query\./);
    await expect(frame.getByTestId('task-plan-status')).toHaveText('The planner is revising the plan');
    await typeInto(win, planner, 'exitplan # Search plan | - Add the field | - Handle an empty query | - Test it');
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan-view').locator('li')).toHaveCount(3, { timeout: 15_000 });
    await frame.getByTestId('task-versions').locator('summary').click();
    await expect(frame.getByTestId('task-versions').locator('li')).toHaveCount(2);
    await expect(frame.getByTestId('task-versions').locator('li').first()).toContainText('feedback sent');
    await expect(frame.getByTestId('task-versions').locator('blockquote')).toHaveText('Also handle an empty query.');

    // Approval ends the planner's turn and starts a fresh Codex session with the brief.
    await frame.getByTestId('task-approve').click();
    await expect.poll(() => oxyTest(win).text(planner)).toContain('The user approved this plan');
    const codex = await agentTerminal(win, 'codex');
    await expect.poll(() => oxyTest(win).text(codex)).toContain('PROMPT: Implement the user-approved plan in');
    await expect.poll(() => oxyTest(win).text(codex)).toContain('brief.md');
    await expect.poll(() => oxyTest(win).activeTerminalId()).toBe(codex);
    await taskFrame(win);
    await expect(frame.getByTestId('task-plan-status')).toHaveText('Plan approved');
    await expect(frame.getByTestId('task-delivery')).toHaveCount(0);

    await frame.getByTestId('task-review').click();
    const reviewer = await agentTerminal(win, 'claude-code', 1);
    await expect.poll(() => oxyTest(win).text(reviewer)).toContain('PROMPT: Review the current changes');
    expect(await oxyTest(win).text(reviewer)).toMatch(/--settings \S+claude-reviewer-settings\.json\s*$/m);
    await taskFrame(win);
    await frame.getByTestId('task-done').click();
    await expect(frame.getByText('COMPLETED', { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Task types into chosen sessions once they are ready, follows the project when moved, and Changes reuses an idle agent', async () => {
  test.setTimeout(120_000);
  const { app, win, root, claudeHome } = await setup('task-sessions');
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
    // A chosen idle session has the prompt typed; its native plan document is captured.
    await expect.poll(() => oxyTest(win).text(planner)).toContain('Improve the search field');
    const session = (await agents(win)).find((a) => a.terminalId === planner)!.sessionId;
    await mkdir(join(claudeHome, 'plans'), { recursive: true });
    await mkdir(join(claudeHome, 'projects', '-fixture'), { recursive: true });
    await writeFile(join(claudeHome, 'plans', 'search-plan.md'), '# Search plan\nAdd a keyboard shortcut and test it.');
    await writeFile(
      join(claudeHome, 'projects', '-fixture', `${session}.jsonl`),
      JSON.stringify({ slug: 'search-plan', message: { content: [{ type: 'text', text: 'PRIVATE CONVERSATION' }] } }),
    );
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
    expect(await oxyTest(win).text(implementer)).not.toContain('PRIVATE CONVERSATION');
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
