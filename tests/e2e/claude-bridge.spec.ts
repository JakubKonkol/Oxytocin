import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launch';
import { connect, freePort } from './helpers/mcp';
import { activeProjectId, oxyTest, run, waitForTerminal } from './helpers/terminal';

const fakeClaude = join(repoRoot, 'tests/fixtures/agents/node_modules/@anthropic-ai/claude-code/cli.js');
const fakeCli = join(repoRoot, 'tests/fixtures/agents/fake-claude-plugin-cli.mjs');

interface Agent {
  terminalId: string;
  state: string;
  stateSource: string;
  sessionId?: string;
  waitingFor?: string;
}

/** A `claude` command that runs the fake plugin CLI (a .cmd on Windows). */
async function claudeWrapper(dir: string, log: string): Promise<string> {
  if (process.platform === 'win32') {
    const path = join(dir, 'claude.cmd');
    await writeFile(path, `@set "FAKE_CLAUDE_CLI_LOG=${log}"\r\n@"${process.execPath}" "${fakeCli}" %*\r\n`);
    return path;
  }
  const path = join(dir, 'claude');
  await writeFile(path, `#!/bin/sh\nFAKE_CLAUDE_CLI_LOG="${log}" exec "${process.execPath}" "${fakeCli}" "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

const agents = (win: Page) => win.evaluate(() => window.oxy.invoke('agents:list')) as Promise<Agent[]>;

// M9-T5: Claude Code hooks → the bridge endpoint → agent states from the `hook` source; install/remove with consent.
test('Claude Code Bridge: hook events drive agent states; the setup panel installs and removes the hooks', async () => {
  test.setTimeout(90_000);
  const work = await mkdtemp(join(tmpdir(), 'oxy-e2e-bridge-'));
  const cliLog = join(work, 'cli.log');
  await writeFile(cliLog, '');
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const port = await freePort();
  const hooksJson = join(
    userData,
    'plugin-data/oxytocin.claude-code-bridge/claude-marketplace/oxytocin-bridge/hooks/hooks.json',
  );
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'claudeBridge.port': port,
      'claudeBridge.claudeCommand': await claudeWrapper(work, cliLog),
      'terminal.env': { FAKE_CLAUDE_HOOKS: hooksJson },
    }),
  );
  const claudeDir = await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-'));
  const { app, win } = await launchApp({
    userData,
    project: await mkdtemp(join(tmpdir(), 'oxy-e2e-project-')),
    env: { CLAUDE_CONFIG_DIR: claudeDir },
  });
  try {
    const id = await waitForTerminal(win);
    // The generated Claude Code plugin points at the configured port.
    await expect
      .poll(() => readFile(hooksJson, 'utf8').catch(() => ''))
      .toContain(`http://127.0.0.1:${port}/claude/hook`);

    await run(win, `node "${fakeClaude}"`);
    await expect.poll(() => oxyTest(win).text(id)).toContain('fake-claude>');
    const badge = win.getByTestId('terminal-kind-badge');
    await expect(badge).toHaveText('AI AGENT', { timeout: 10_000 });
    // Claude Code runs without the bridge: the status bar offers the setup.
    const hint = win.getByTestId('status-item-claudeBridge.hint');
    await expect(hint).toContainText('Claude Code hooks');

    // Hook requests carry the terminal's token and id (interpolated like Claude Code does).
    await run(win, 'hook UserPromptSubmit');
    await expect.poll(() => oxyTest(win).text(id)).toContain('hook UserPromptSubmit 204');
    await expect
      .poll(async () => (await agents(win)).find((a) => a.terminalId === id))
      .toMatchObject({ state: 'working', stateSource: 'hook', sessionId: expect.stringMatching(/^fake-/) });
    await run(win, 'hook PermissionRequest');
    await expect(badge).toHaveText('WAITING', { timeout: 10_000 });
    await expect(win.getByTestId('tab-status-dot')).toHaveAttribute('title', /waiting for tool permission/);
    await run(win, 'hook Stop');
    await expect(badge).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
    expect((await agents(win)).find((a) => a.terminalId === id)?.stateSource).toBe('hook');
    // Without the token (Claude Code outside Oxytocin): rejected.
    const outside = await fetch(`http://127.0.0.1:${port}/claude/hook`, {
      method: 'POST',
      headers: { authorization: 'Bearer ', 'x-oxytocin-terminal': id },
      body: '{"hook_event_name":"UserPromptSubmit"}',
    });
    expect(outside.status).toBe(401);

    // Setup panel (from the hint, which then goes away): explains, installs with the claude CLI, removes.
    await hint.click();
    await expect(hint).toHaveCount(0);
    const frame = () => win.frames().find((f) => f.url().startsWith('oxy-plugin://oxytocin.claude-code-bridge/'));
    await expect.poll(() => !!frame(), { timeout: 15_000 }).toBe(true);
    const panel = frame()!;
    await expect(panel.locator('#status-endpoint')).toHaveText(`listening on 127.0.0.1:${port}`);
    await expect(panel.locator('#status-installed')).toHaveText('not installed');
    await expect(panel.locator('#status-events')).toContainText('3 received');
    await panel.locator('#install').click();
    await expect(panel.locator('#output')).toContainText('Successfully installed plugin: oxytocin-bridge@oxytocin');
    await expect(panel.locator('#status-installed')).toHaveText('the bridge is installed');
    const calls = async () =>
      (await readFile(cliLog, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as string[]).join(' '));
    const marketplace = join(userData, 'plugin-data/oxytocin.claude-code-bridge/claude-marketplace');
    expect(await calls()).toEqual(
      expect.arrayContaining([
        `plugin marketplace add ${marketplace}`,
        'plugin install oxytocin-bridge@oxytocin --scope user',
      ]),
    );
    await panel.locator('#uninstall').click();
    await expect(panel.locator('#status-installed')).toHaveText('not installed');
    expect(await calls()).toContain('plugin marketplace remove oxytocin');
  } finally {
    await app.close();
  }
});

// Phase 4 of the Code Map remediation: prompt-time pointers through the `UserPromptSubmit` hook.
interface HookResponse {
  event: string;
  status: number;
  body: string;
}

/** A project with two small TypeScript modules, a Claude bridge on a free port and a fake Claude Code in a terminal. */
async function pointerSetup(options: { mcp?: boolean } = {}) {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-pointers-'));
  await mkdir(join(project, 'src'));
  await writeFile(
    join(project, 'src/session-token.ts'),
    'export function validateSessionToken(token: string): boolean {\n  return token.length > 8;\n}\n',
  );
  await writeFile(
    join(project, 'src/billing.ts'),
    'export function calculateInvoiceTotal(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n',
  );
  const out = join(userData, 'hook-responses.jsonl');
  await writeFile(out, '');
  const port = await freePort();
  const mcpPort = options.mcp ? await freePort() : 0;
  const hooksJson = join(
    userData,
    'plugin-data/oxytocin.claude-code-bridge/claude-marketplace/oxytocin-bridge/hooks/hooks.json',
  );
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'claudeBridge.port': port,
      'terminal.env': { FAKE_CLAUDE_HOOKS: hooksJson, FAKE_CLAUDE_HOOK_OUT: out },
      ...(options.mcp ? { 'mcp.enabled': true, 'mcp.port': mcpPort } : {}),
    }),
  );
  const launched = await launchApp({
    userData,
    project,
    env: { CLAUDE_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'oxy-e2e-claude-')) },
  });
  const { win } = launched;
  const terminalId = await waitForTerminal(win);
  await expect.poll(() => readFile(hooksJson, 'utf8').catch(() => '')).toContain(`:${port}/claude/hook`);
  const projectId = await activeProjectId(win);
  await win.evaluate((projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: true }), projectId);
  await expect
    .poll(async () => {
      const status = (await win.evaluate(
        (projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }),
        projectId,
      )) as { state: string };
      return status.state;
    })
    .toBe('ready');
  await run(win, `node "${fakeClaude}"`);
  const idle = () =>
    expect.poll(async () => (await oxyTest(win).text(terminalId)).trimEnd().endsWith('fake-claude>')).toBe(true);
  await idle();
  const responses = async (): Promise<HookResponse[]> =>
    (await readFile(out, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HookResponse);
  /** Sends one hook event like Claude Code does and returns what Oxytocin answered. */
  const hook = async (command: string): Promise<HookResponse> => {
    const before = (await responses()).length;
    await run(win, `hook ${command}`);
    await expect.poll(async () => (await responses()).length).toBe(before + 1);
    await idle();
    return (await responses())[before]!;
  };
  /** The `additionalContext` of a response (empty when Oxytocin added nothing). */
  const contextOf = (response: HookResponse): string =>
    response.body
      ? (JSON.parse(response.body) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
          .additionalContext
      : '';
  const setSuggestions = (enabled: boolean) =>
    win.evaluate(([projectId, enabled]) => window.oxy.invoke('codeMap:setPromptSuggestions', { projectId, enabled }), [
      projectId,
      enabled,
    ] as const);
  return { ...launched, project, projectId, mcpPort, hook, contextOf, setSuggestions };
}

test('Claude Code Bridge: no code pointers unless the project turns on prompt suggestions in the Code Map tab', async () => {
  test.setTimeout(90_000);
  const { app, win, hook, contextOf, projectId } = await pointerSetup();
  try {
    const prompt = 'UserPromptSubmit where does validateSessionToken reject a short session token';
    // Off by default: the prompt goes through untouched (an empty 2xx).
    const off = await hook(prompt);
    expect(off.status).toBe(204);
    expect(contextOf(off)).toBe('');

    // The Code Map tab explains the privacy of the setting and turns it on for this project only.
    await win.getByRole('button', { name: 'Code Map status' }).click();
    const dialog = win.getByTestId('project-settings');
    const suggest = dialog.getByTestId('code-map-prompt-suggestions');
    await expect(suggest).not.toBeChecked();
    await expect(dialog.getByTestId('code-map-prompt-suggestions-note')).toContainText('never stored or logged');
    await suggest.check();
    await expect(suggest).toBeChecked();
    await expect
      .poll(async () => {
        const projects = (await win.evaluate(() => window.oxy.invoke('projects:list'))) as {
          id: string;
          settings: { codeMap?: { promptSuggestions?: boolean } };
        }[];
        return projects.find((p) => p.id === projectId)?.settings.codeMap?.promptSuggestions;
      })
      .toBe(true);
    await suggest.uncheck();
    await expect(suggest).not.toBeChecked();
  } finally {
    await app.close();
  }
});

test('Claude Code Bridge: a strong match adds up to three pointers once per session, never for harness text', async () => {
  test.setTimeout(120_000);
  const { app, hook, contextOf, setSuggestions, mcpPort, project, userData } = await pointerSetup({ mcp: true });
  try {
    // The pointers need the confidence signal of the Code Map search (phase 2 of the remediation plan). Until the
    // ranking reports it, Oxytocin correctly adds nothing, so this story cannot run.
    await expect.poll(async () => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    const client = await connect(mcpPort, token);
    try {
      const probe = await client.call('oxy_find_code', {
        cwd: project,
        format: 'json',
        query: 'validateSessionToken',
      });
      const data = (JSON.parse(probe.result!.content![0]!.text) as { data?: { strong?: boolean; coverage?: number } })
        .data;
      test.skip(
        data?.strong === undefined && data?.coverage === undefined,
        'The Code Map search does not report a confidence signal yet',
      );
    } finally {
      client.close();
    }

    const question = 'UserPromptSubmit where does validateSessionToken reject a short session token';
    await setSuggestions(true);
    const first = contextOf(await hook(question));
    expect(first).toContain('Code Map — likely relevant code');
    expect(first).toMatch(/src\/session-token\.ts:1-3 function validateSessionToken/);
    expect(first.split('\n').length).toBeLessThanOrEqual(4);
    // No source and nothing from the prompt itself is added.
    expect(first).not.toContain('token.length');
    expect(first).not.toContain('reject a short');

    // The same pointers are not repeated within the session ...
    const repeated = await hook(question);
    expect(repeated.status).toBe(204);
    // ... harness text is never searched ...
    const harness = await hook(
      'UserPromptSubmit <task-notification>validateSessionToken finished running in the background</task-notification>',
    );
    expect(harness.status).toBe(204);
    // ... and a session that ended starts over.
    expect((await hook('SessionEnd')).status).toBe(204);
    expect(contextOf(await hook(question))).toContain('src/session-token.ts:1-3 function validateSessionToken');

    // Turning the setting off stops the pointers at once.
    await hook('SessionEnd');
    await setSuggestions(false);
    expect((await hook(question)).status).toBe(204);
  } finally {
    await app.close();
  }
});
