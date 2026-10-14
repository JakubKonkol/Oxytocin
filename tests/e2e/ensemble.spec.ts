import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  claudeConfigDir,
  ensembleRecords,
  gitIn,
  gitRepo,
  readLog,
  useFakeClaude,
  waitForStatus,
} from './helpers/ensemble';
import { launchApp } from './helpers/launch';

test('Ensemble: a feature task runs plan → gate → implement ⇄ review → tests → gate in its worktree and is merged', async () => {
  test.setTimeout(180_000);
  const repo = await gitRepo();
  // The test stage fails until the implementer wrote fixed.txt.
  await writeFile(join(repo, 'check.js'), "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1);\n");
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'check');
  const claude = await claudeConfigDir();
  const before = await claude.hash();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const log = join(dir, 'agents.jsonl');
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      Grace: [{ verdict: 'changes' }, { verdict: 'approve' }],
      Linus: [{}, {}, { writeFile: 'fixed.txt' }],
    }),
  );
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: log, FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    // The "+" menu of the workspace group opens Ensemble.
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await expect(panel.getByTestId('ensemble-new-task-view')).toBeVisible();
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="pipeline"]').click();
    await panel.getByTestId('ensemble-template-feature').click();
    await panel.getByTestId('ensemble-new-title').fill('CSV export');
    await panel.getByTestId('ensemble-new-description').fill('Add CSV export to the reports page.');
    await panel.getByTestId('ensemble-create').click();

    // The builder: the template's team and pipeline; the test command is changed.
    await expect(panel.getByTestId('ensemble-agent-card')).toHaveCount(3);
    await panel.locator('[data-testid="ensemble-stage-card"][data-stage-id="tests"]').click();
    await panel.getByTestId('ensemble-stage-command').fill('node check.js');
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    await panel.getByTestId('ensemble-start').click();

    // Plan, then the plan gate.
    await expect(panel.getByTestId('ensemble-flow')).toBeVisible();
    await panel.getByTestId('ensemble-open-gate').click();
    const gate = win.getByTestId('ensemble-gate-dialog');
    await expect(gate).toContainText('Ada saw:');
    await gate.getByTestId('ensemble-gate-approve').click();
    await expect(gate).toBeHidden();
    await expect(panel.getByTestId('ensemble-open-gate')).toBeHidden();

    // Implement ⇄ review (two rounds), the failing command goes back to Linus, then the final gate.
    await expect(panel.getByTestId('ensemble-open-gate')).toBeVisible({ timeout: 90_000 });
    const mid = (await ensembleRecords(win))[0]!;
    expect(mid.run.stages.find((s) => s.stageId === 'implement')).toMatchObject({ status: 'done', round: 2 });
    expect(mid.run.stages.find((s) => s.stageId === 'tests')).toMatchObject({ status: 'done', attempts: 2 });
    await expect(panel.getByTestId('ensemble-decisions')).toContainText('back to Linus');
    await panel.getByTestId('ensemble-open-gate').click();
    await win.getByTestId('ensemble-gate-dialog').getByTestId('ensemble-gate-approve').click();

    const done = await waitForStatus(win, mid.task.id, 'done');
    expect(done.run.checkpoints.length).toBeGreaterThan(0);
    // The planner and the reviewer never got a slash command; models and efforts are per agent.
    const starts = (await readLog(log)).filter((e) => e.event === 'start');
    const args = (agent: string) => starts.find((s) => s.agent === agent)!.args!;
    expect(args('Ada')).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'high']));
    expect(args('Grace')).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'high']));
    expect(await claude.hash()).toBe(before);
    expect(existsSync(join(repo, 'fixed.txt'))).toBe(false);

    // Finish: merge the branch into main.
    await panel.getByTestId('ensemble-open-finish').click();
    const finish = win.getByTestId('ensemble-finish-dialog');
    await finish.getByTestId('ensemble-finish-merge').click();
    await finish.getByTestId('ensemble-finish-run').click();
    await expect(finish).toBeHidden({ timeout: 30_000 });
    expect(existsSync(join(repo, 'fixed.txt'))).toBe(true);
    expect(gitIn(repo, 'log', '--oneline', '-5')).toMatch(/Merge branch 'ensemble\/csv-export'/);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    await expect(panel.getByTestId('ensemble-needs')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Ensemble: a peeked agent can be taken over and handed back; a read-only team works in the current checkout', async () => {
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const script = join(dir, 'script.json');
  // The researcher keeps working long enough to be watched.
  await writeFile(script, JSON.stringify({ Rosalind: [{ waitMs: 5000 }] }));
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: join(dir, 'log.jsonl'), FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="pipeline"]').click();
    await panel.getByTestId('ensemble-template-research').click();
    await panel.getByTestId('ensemble-new-title').fill('Spike');
    await panel.getByTestId('ensemble-create').click();
    await panel.getByTestId('ensemble-workspace-mode').locator('[data-value="current-checkout"]').click();
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    await panel.getByTestId('ensemble-start').click();
    const node = panel.locator('[data-testid="ensemble-agent-node"]').first();
    await expect(node).toHaveAttribute('data-state', 'working', { timeout: 20_000 });
    await node.click();
    const drawer = panel.getByTestId('ensemble-drawer');
    await expect(drawer.locator('.xterm')).toBeVisible();
    await drawer.getByTestId('ensemble-take-over').click();
    await expect(drawer.getByTestId('ensemble-take-over')).toHaveText(/Hand back/);
    await drawer.getByTestId('ensemble-take-over').click();
    await drawer.getByTestId('ensemble-drawer-close').click();
    const id = (await ensembleRecords(win))[0]!.task.id;
    await waitForStatus(win, id, 'running');
    const events = (await ensembleRecords(win))[0]!.run.events.map((e) => e.text);
    expect(events).toEqual(expect.arrayContaining(['You took over Rosalind', 'You handed Rosalind back']));
    // A read-only team in the current checkout: no worktree, the stage runs to the gate.
    await expect(panel.getByTestId('ensemble-open-gate')).toBeVisible({ timeout: 60_000 });
    expect((await ensembleRecords(win))[0]!.run.worktree?.mode).toBe('current-checkout');
    await panel.getByTestId('ensemble-open-gate').click();
    await win.getByTestId('ensemble-gate-dialog').getByTestId('ensemble-gate-approve').click();
    await waitForStatus(win, id, 'done');
    // Done in the current checkout: nothing to finish.
    await expect(panel.getByTestId('ensemble-finish')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('Ensemble: agent costs come from the Usage Monitor and the budget pauses the task', async () => {
  test.setTimeout(120_000);
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  await mkdir(join(claude.dir, 'projects'), { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const script = join(dir, 'script.json');
  // 100k output tokens of claude-opus-5-5 cost $2.00 (built-in prices); the researcher keeps working meanwhile.
  await writeFile(
    script,
    JSON.stringify({ Rosalind: [{ usage: { model: 'claude-opus-5-5', output: 100_000 }, waitMs: 60_000 }] }),
  );
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ 'usage.pricing.autoUpdate': false }));
  const { app, win } = await launchApp({
    userData,
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: join(dir, 'log.jsonl'), FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-new-mode').locator('[data-value="pipeline"]').click();
    await panel.getByTestId('ensemble-template-research').click();
    await panel.getByTestId('ensemble-new-title').fill('Costly spike');
    await panel.getByTestId('ensemble-create').click();
    await panel.getByTestId('ensemble-workspace-mode').locator('[data-value="current-checkout"]').click();
    await panel.getByTestId('ensemble-budget').fill('1');
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    await panel.getByTestId('ensemble-start').click();

    const id = (await ensembleRecords(win))[0]!.task.id;
    const paused = await waitForStatus(win, id, 'paused', 60_000);
    expect(paused.run.pauseReason).toBe('The budget of $1 is reached');
    expect(paused.run.costUsd).toBeCloseTo(2, 2);
    await expect(panel.getByTestId('ensemble-agent-cost').first()).toHaveText('$2.00');
    await expect(panel.getByTestId('ensemble-run-cost')).toHaveText('$2.00 of $1.00');
    await win.evaluate((taskId) => window.oxy.invoke('ensemble:command', { taskId, event: { type: 'stop' } }), id);
    await waitForStatus(win, id, 'stopped');
  } finally {
    await app.close();
  }
});

test('Ensemble lead & crew: members can be left out; each delegation is a fresh session with only the lead brief', async () => {
  test.setTimeout(150_000);
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const log = join(dir, 'agents.jsonl');
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      // Research and code in parallel; then new work for Linus (a fresh session); then a fix in the same session.
      Barbara: [
        {
          delegate: [
            { to: 'Rosalind', work: 'Find where the reports toolbar is rendered.' },
            { to: 'Linus', work: 'Write the CSV exporter in export.txt.' },
          ],
          then: [
            [{ to: 'Linus', work: 'Write the importer in import.txt.' }],
            [{ to: 'Linus', work: 'Fix the quoting in import.txt.', same_session: true }],
          ],
        },
      ],
      Linus: [{ writeFile: 'export.txt' }, { writeFile: 'import.txt' }, {}],
    }),
  );
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: log, FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    // Two ways to start: lead & crew (the default) or a custom pipeline; the quick start is gone.
    await expect(panel.getByTestId('ensemble-new-mode').locator('[data-value]')).toHaveCount(2);
    await expect(panel.getByTestId('ensemble-new-mode')).toContainText('Custom pipeline');
    await expect(panel.getByTestId('ensemble-crew-start')).toBeVisible();
    // Leave the tester and the API researcher out of this task (remembered for the next one).
    const member = (id: string) =>
      panel.locator(`[data-testid="ensemble-crew-summary-member"][data-member-id="${id}"]`);
    await expect(member('margaret')).toHaveAttribute('aria-pressed', 'true');
    await member('margaret').click();
    await member('tim').click();
    await expect(member('margaret')).toHaveAttribute('aria-pressed', 'false');

    await panel.getByTestId('ensemble-crew-prompt').fill('Add CSV export and import to the reports page.');
    await panel.getByTestId('ensemble-crew-approve').uncheck();
    await panel.getByTestId('ensemble-crew-go').click();
    await expect(panel.getByTestId('ensemble-flow')).toBeVisible();
    const id = (await ensembleRecords(win))[0]!.task.id;
    const done = await waitForStatus(win, id, 'done', 120_000);
    expect(done.task.agents.map((a) => a.name)).toEqual(['Barbara', 'Linus', 'Grace', 'Rosalind']);
    expect(done.task.leadId).toBe('barbara');

    const entries = await readLog(log);
    const lead = entries.find((e) => e.agent === 'Barbara' && e.event === 'message')!.text!;
    expect(lead).toContain('Your crew:');
    expect(lead).not.toContain('Margaret');
    expect(lead).not.toContain('- Tim (API researcher)');
    // Linus ran in two sessions: the importer started fresh, the fix continued that session.
    const linusStarts = entries.filter((e) => e.agent === 'Linus' && e.event === 'start');
    expect(linusStarts).toHaveLength(2);
    const sessionOf = (args: string[]) => args[args.indexOf('--session-id') + 1];
    expect(sessionOf(linusStarts[0]!.args!)).not.toBe(sessionOf(linusStarts[1]!.args!));
    const linusMessages = entries.filter((e) => e.agent === 'Linus' && e.event === 'message').map((e) => e.text!);
    expect(linusMessages).toHaveLength(3);
    // Each piece carries the lead's brief only: no research report or earlier result typed along.
    expect(linusMessages[1]).toContain('Write the importer in import.txt.');
    expect(linusMessages[1]).not.toContain('Results so far');
    expect(linusMessages[1]).not.toContain('Rosalind');
    expect(linusMessages[2]).toContain('Fix the quoting in import.txt.');
    // The crew member gets the task as background in its system prompt and is not offered delegation.
    const promptFile = linusStarts[1]!.args![linusStarts[1]!.args!.indexOf('--append-system-prompt-file') + 1]!;
    const system = await readFile(promptFile, 'utf8');
    expect(system).toContain('## Background: the whole task (Barbara handles it');
    expect(system).not.toContain('oxy_ensemble_delegate');
    // The reports tell the lead who still works for it and how long the task has run.
    const reports = entries.filter(
      (e) => e.agent === 'Barbara' && e.event === 'message' && /Report from/.test(e.text!),
    );
    expect(reports).toHaveLength(4);
    expect(reports.at(-1)!.text).toMatch(/Nothing else you delegated is open\. \(elapsed \d+s\)$/);
    expect(gitIn(done.run.worktree!.path, 'show', '--stat', 'HEAD')).toContain('import.txt');

    // The choice of members is remembered for the next task.
    await panel.getByTestId('ensemble-new-task').click();
    await expect(member('margaret')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
  }
});

test('Ensemble: "Customize first" opens the builder; every model of the CLI can be picked, or any other id', async () => {
  const repo = await gitRepo();
  const { app, win } = await launchApp({ project: repo });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    await panel.getByTestId('ensemble-crew-prompt').fill('Refactor the exporter');
    await panel.getByTestId('ensemble-crew-customize').click();
    await expect(panel.getByTestId('ensemble-builder')).toBeVisible();
    const barbara = panel.locator('[data-testid="ensemble-agent-card"][data-agent-id="barbara"]');
    const model = barbara.getByTestId('ensemble-agent-model');
    await expect(model).toHaveValue('claude-opus-5-5');
    // Every model is offered, whatever is selected (a datalist used to filter them by the current value).
    const options = await model.locator('option').allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(10);
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'opus'])
      expect(options.some((o) => o.startsWith(id))).toBe(true);
    await model.selectOption('claude-sonnet-5-5');
    await model.selectOption('__custom__');
    await barbara.getByTestId('ensemble-agent-model-custom').fill('claude-opus-5');
    await expect(panel.getByTestId('ensemble-save-state')).toHaveText('Saved');
    const record = (await ensembleRecords(win))[0]!;
    expect(record.task.agents.find((a) => a.id === 'barbara')!.model).toBe('claude-opus-5');
    expect(record.run.status).toBe('draft');
  } finally {
    await app.close();
  }
});

test('Ensemble lead & crew: the crew is set up once; the lead hands code and research to the crew in parallel', async () => {
  test.setTimeout(120_000);
  const repo = await gitRepo();
  const claude = await claudeConfigDir();
  const dir = await mkdtemp(join(tmpdir(), 'oxy-e2e-ens-'));
  const log = join(dir, 'agents.jsonl');
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      Barbara: [
        {
          delegate: [
            { to: 'Linus', work: 'Write the CSV exporter in export.txt.' },
            { to: 'Rosalind', work: 'Find how the reports page renders its toolbar.' },
          ],
        },
      ],
      Linus: [{ writeFile: 'export.txt', waitMs: 1500 }],
      Rosalind: [{ waitMs: 1500 }],
    }),
  );
  const { app, win } = await launchApp({
    project: repo,
    env: { CLAUDE_CONFIG_DIR: claude.dir, FAKE_ENSEMBLE_LOG: log, FAKE_ENSEMBLE_SCRIPT: script },
  });
  try {
    await useFakeClaude(win);
    await win.getByTestId('group-add').first().click();
    await expect(win.getByTestId('add-tool-ensemble')).toContainText('Beta');
    await win.getByTestId('add-tool-ensemble').click();
    const panel = win.getByTestId('ensemble-panel');
    // Ensemble is in beta: a notice on top, a badge next to its name.
    await expect(panel.getByTestId('ensemble-beta-notice')).toContainText('Ensemble is in beta');
    await expect(panel.getByTestId('ensemble-beta-badge').first()).toBeVisible();
    await expect(panel.getByTestId('ensemble-crew-start')).toBeVisible();
    await expect(panel.getByTestId('ensemble-crew-summary-lead')).toContainText('Barbara');

    // Set up the crew: Linus runs on Sonnet with high effort, the tester leaves the crew.
    await panel.getByTestId('ensemble-crew-setup').click();
    const editor = panel.getByTestId('ensemble-crew-editor');
    const linus = editor.locator('[data-testid="ensemble-crew-member"][data-member-id="linus"]');
    await linus.getByTestId('ensemble-crew-model').selectOption('claude-sonnet-5-5');
    await linus.getByTestId('ensemble-crew-effort').selectOption('high');
    await editor
      .locator('[data-testid="ensemble-crew-member"][data-member-id="margaret"]')
      .getByTestId('ensemble-crew-remove')
      .click();
    await editor.getByTestId('ensemble-crew-save').click();
    await expect(editor).toBeHidden();
    await expect(panel.getByTestId('ensemble-crew-summary-member')).toHaveCount(4);
    await expect(panel.getByTestId('ensemble-crew-summary')).toContainText('claude-sonnet-5-5 · high');

    await panel.getByTestId('ensemble-crew-prompt').fill('Add CSV export to the reports page.');
    await panel.getByTestId('ensemble-crew-approve').uncheck();
    await panel.getByTestId('ensemble-crew-go').click();
    await expect(panel.getByTestId('ensemble-flow')).toBeVisible();
    const id = (await ensembleRecords(win))[0]!.task.id;
    const done = await waitForStatus(win, id, 'done', 90_000);
    expect(done.task.agents.map((a) => a.name)).toEqual(['Barbara', 'Linus', 'Grace', 'Rosalind', 'Tim']);
    expect(done.task.pipeline.map((s) => s.title)).toEqual(['Lead the crew']);
    expect(done.run.handoffs.map((h) => [h.agentId, h.kind])).toEqual(
      expect.arrayContaining([
        ['linus', 'implementation'],
        ['rosalind', 'research'],
        ['barbara', 'implementation'],
      ]),
    );
    // What the crew wrote is committed on the task's branch.
    expect(done.run.checkpoints).toHaveLength(1);
    expect(gitIn(done.run.worktree!.path, 'show', '--stat', 'HEAD')).toContain('export.txt');

    const entries = await readLog(log);
    const starts = entries.filter((e) => e.event === 'start' && e.args?.includes('--mcp-config'));
    // Only the crew members that got work were started; models and efforts come from the crew.
    expect(starts.map((s) => s.agent).sort()).toEqual(['Barbara', 'Linus', 'Rosalind']);
    expect(starts.find((s) => s.agent === 'Linus')!.args).toEqual(
      expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'high']),
    );
    const lead = entries.find((e) => e.agent === 'Barbara' && e.event === 'message')!.text!;
    expect(lead).toContain('Your crew:');
    expect(lead).toContain('- Linus (Implementer) — claude-sonnet-5-5, effort high · edits files');
    expect(lead).not.toContain('Margaret');
    // Both reports reached the lead as messages.
    const reports = entries.filter(
      (e) => e.agent === 'Barbara' && e.event === 'message' && /Report from/.test(e.text!),
    );
    expect(reports).toHaveLength(2);
    await panel.getByTestId('ensemble-beta-notice-close').click();
    await expect(panel.getByTestId('ensemble-beta-notice')).toBeHidden();
  } finally {
    await app.close();
  }
});
