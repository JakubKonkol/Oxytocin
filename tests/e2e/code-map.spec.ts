import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { activeProjectId } from './helpers/terminal';
import { connect, freePort } from './helpers/mcp';
import { userDataWithPlugins } from './helpers/plugins';
import { CodeMapPluginResultSchema } from '../../src/shared/domain/code-map-plugin';

test('public Code Map plugin API opens verified source and rejects disabled projects', async () => {
  const project = await mkdtemp(join(tmpdir(), 'oxy-map-plugin-ui-'));
  await writeFile(join(project, 'api.ts'), 'export function pluginSource() {}\n');
  const userData = await userDataWithPlugins(['code-map'], { 'editor.preset': 'oxytocin' });
  const { app, win } = await launchApp({ project, userData });
  try {
    const id = await activeProjectId(win);
    await win.evaluate(
      (projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: true, ignoreInGit: true }),
      id,
    );
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
              state: string;
            }
          ).state,
      )
      .toBe('ready');
    const result = CodeMapPluginResultSchema.parse(
      await win.evaluate(
        (projectId) =>
          window.oxy.invoke('plugins:executeCommand', {
            id: 'map.query',
            args: [{ projectId, checkoutId: projectId, kind: 'slice', view: 'file', root: { path: 'api.ts' } }],
          }),
        id,
      ),
    );
    if (result.data?.kind !== 'slice') throw new Error('Expected a slice');
    const node = result.data.nodes.find((n) => n.kind === 'symbol')!;
    await win.evaluate((locator) => window.oxy.invoke('plugins:executeCommand', { id: 'map.open', args: [locator] }), {
      projectId: id,
      checkoutId: id,
      generation: result.freshness.generation,
      path: node.path,
      sha256: node.sha256,
      span: node.span,
      symbolId: node.id,
    });
    await expect(win.getByTestId('code-panel')).toContainText('pluginSource');
    await win.evaluate((projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: false }), id);
    await expect(
      win.evaluate(
        (projectId) =>
          window.oxy.invoke('plugins:executeCommand', {
            id: 'map.query',
            args: [{ projectId, checkoutId: projectId, kind: 'search', query: 'pluginSource' }],
          }),
        id,
      ),
    ).rejects.toThrow();
  } finally {
    await app.close();
  }
});

test('Code Map settings build, update, pause, rebuild, preserve settings and delete disabled data', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-map-ui-')), 'map-project');
  await mkdir(project);
  await promisify(execFile)('git', ['--no-optional-locks', 'init'], { cwd: project, windowsHide: true });
  await writeFile(join(project, 'api.ts'), 'export function first() { return 1 }\n');
  const { app, win } = await launchApp({ project });
  try {
    const id = await activeProjectId(win);
    const map = join(project, '.oxy/code-map');
    const graph = async () =>
      JSON.parse(await readFile(join(map, 'graph.json'), 'utf8')) as {
        files: { path: string }[];
        symbols: { name: string }[];
      };
    await win.getByTestId('projects-item-map-project').click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    const dialog = win.getByTestId('project-settings');
    await dialog.getByTestId('project-settings-tab-code-map').click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Disabled');
    await dialog.getByTestId('code-map-enabled').click();
    const confirm = win
      .getByRole('alertdialog')
      .filter({ has: win.getByRole('heading', { name: 'Enable Code Map?' }) });
    await expect(confirm.getByRole('checkbox')).toBeChecked();
    await confirm.getByRole('button', { name: 'Enable Code Map', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready', { timeout: 20_000 });
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toContain('/.oxy/');
    expect((await graph()).symbols.map((s) => s.name)).toContain('first');
    await dialog.getByRole('button', { name: 'Copy agent instructions' }).click();
    expect(((await win.evaluate(() => window.oxy.invoke('clipboard:read'))) as { text: string }).text).toContain(
      'MAP.md',
    );
    await writeFile(join(project, 'api.ts'), 'export function second() { return 2 }\n');
    await expect.poll(async () => (await graph()).symbols.map((s) => s.name)).toContain('second');
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await dialog.getByRole('button', { name: 'Pause updates', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Paused');
    const paused = await readFile(join(map, 'graph.json'), 'utf8');
    await writeFile(join(project, 'api.ts'), 'export function resumed() { return 3 }\n');
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
              pendingFiles: number;
            }
          ).pendingFiles,
      )
      .toBeGreaterThan(0);
    expect(await readFile(join(map, 'graph.json'), 'utf8')).toBe(paused);
    await dialog.getByRole('button', { name: 'Resume updates', exact: true }).click();
    await expect.poll(async () => (await graph()).symbols.map((s) => s.name)).toContain('resumed');
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await dialog.getByRole('button', { name: 'Rebuild', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    expect(await readFile(join(map, 'MAP.md'), 'utf8')).toContain('resumed');
    await dialog.getByTestId('code-map-ignore-git').click();
    await win.getByRole('button', { name: 'Change Git preference', exact: true }).click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await expect.poll(() => readFile(join(project, '.gitignore'), 'utf8')).not.toContain('/.oxy/');
    const { stdout } = await promisify(execFile)(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'],
      { cwd: project, windowsHide: true },
    );
    expect(stdout).toContain('.oxy/code-map/graph.json');
    expect(stdout).not.toContain('manifest.json');
    expect(stdout).not.toContain('/cache/');
    await dialog.getByTestId('code-map-ignore-git').click();
    await expect.poll(() => readFile(join(project, '.gitignore'), 'utf8')).toContain('/.oxy/');
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready');
    await dialog.getByLabel('Excluded paths').fill('generated/**');
    await dialog.getByRole('button', { name: 'Apply exclusions' }).click();
    await expect(dialog.getByRole('button', { name: 'Apply exclusions' })).toBeDisabled();
    await dialog.getByTestId('project-settings-tab-general').click();
    await dialog.getByTestId('project-settings-name').fill('Map renamed');
    await dialog.getByTestId('project-settings-save').click();
    const saved = (await win.evaluate(() => window.oxy.invoke('projects:list'))) as {
      id: string;
      settings: { codeMap: unknown };
    }[];
    expect(saved.find((p) => p.id === id)?.settings.codeMap).toEqual({
      enabled: true,
      excludedPaths: ['generated/**'],
      ignoreInGit: true,
    });
    await win.getByRole('button', { name: 'Code Map status' }).click();
    await expect(dialog.getByTestId('code-map-tab')).toBeVisible();
    await dialog.getByRole('button', { name: 'Show diagnostics' }).click();
    await expect(dialog.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Open MAP.md', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(win.getByTestId('code-panel')).toContainText('Code Map');
    await win.getByRole('button', { name: 'Code Map status' }).click();
    await dialog.getByTestId('code-map-enabled').click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Disabled');
    const disabled = await readFile(join(map, 'graph.json'), 'utf8');
    await writeFile(join(project, 'api.ts'), 'export function disabled() {}\n');
    // A disabled map has no watcher/periodic worker and retains its last generation.
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate(() => window.oxy.invoke('app:getHostStatus'))) as { name: string; state: string }[]
          ).find((h) => h.name === 'Oxytocin Code Map Host')?.state,
      )
      .toBe('stopped');
    expect(await readFile(join(map, 'graph.json'), 'utf8')).toBe(disabled);
    await dialog.getByRole('button', { name: 'Delete map data', exact: true }).click();
    await win
      .getByRole('alertdialog')
      .filter({ has: win.getByRole('heading', { name: 'Delete map data?' }) })
      .getByRole('button', { name: 'Delete map data', exact: true })
      .click();
    await expect
      .poll(() =>
        stat(map).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
  } finally {
    await app.close();
  }
});

for (const git of [false, true])
  test(`enabling with Git ignore unchecked respects ${git ? 'Git' : 'non-Git'} folders`, async () => {
    const project = await mkdtemp(join(tmpdir(), 'oxy-map-optout-'));
    if (git) await promisify(execFile)('git', ['--no-optional-locks', 'init'], { cwd: project, windowsHide: true });
    await writeFile(join(project, 'index.ts'), 'export const hello = () => 1;\n');
    const { app, win } = await launchApp({ project });
    try {
      const id = await activeProjectId(win);
      await win.locator(`[data-project-id="${id}"]`).click({ button: 'right' });
      await win.getByTestId('project-menu-settings').click();
      await win.getByTestId('project-settings-tab-code-map').click();
      await win.getByTestId('code-map-enabled').click();
      const confirmation = win.getByRole('alertdialog', { name: 'Enable Code Map?' });
      await confirmation.getByRole('checkbox').uncheck();
      await confirmation.getByRole('button', { name: 'Enable Code Map', exact: true }).click();
      await expect
        .poll(
          async () =>
            (
              (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
                state: string;
              }
            ).state,
        )
        .toBe('ready');
      await expect(stat(join(project, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(project, '.oxy/.gitignore'), 'utf8')).toContain('/code-map/cache/');
      await win.evaluate((projectId) => window.oxy.invoke('codeMap:deleteData', { projectId }), id);
      await expect(stat(join(project, '.oxy/code-map'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.close();
    }
  });

test('a C# solution shows Calls coverage for C# and its types, projects and calls in graph.json', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-map-csharp-')), 'csharp-project');
  await cp(resolve('tests/fixtures/code-map/csharp-solution'), project, { recursive: true });
  const { app, win } = await launchApp({ project });
  try {
    await win.getByTestId('projects-item-csharp-project').click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    const dialog = win.getByTestId('project-settings');
    await dialog.getByTestId('project-settings-tab-code-map').click();
    await dialog.getByTestId('code-map-enabled').click();
    await win
      .getByRole('alertdialog', { name: 'Enable Code Map?' })
      .getByRole('button', { name: 'Enable Code Map', exact: true })
      .click();
    await expect(dialog.getByTestId('code-map-state')).toHaveText('Ready', { timeout: 20_000 });
    await expect(dialog.getByTestId('code-map-language-csharp')).toContainText('csharp: Calls');
    await expect(dialog.getByTestId('code-map-language-csharp')).toContainText('Extension methods');
    const graph = JSON.parse(await readFile(join(project, '.oxy/code-map/graph.json'), 'utf8')) as {
      groups: { id: string; kind?: string }[];
      symbols: { id: string; name: string; kind: string }[];
      edges: { from: string; to: string; rel: string }[];
    };
    const order = graph.symbols.find((symbol) => symbol.name === 'Order' && symbol.kind === 'class');
    expect(order).toBeDefined();
    expect(graph.groups.filter((group) => group.kind === 'project')).toHaveLength(3);
    const validate = graph.symbols.find((symbol) => symbol.name === 'Validate')!;
    expect(graph.edges).toContainEqual(expect.objectContaining({ to: validate.id, rel: 'calls' }));
    expect(await readFile(join(project, '.oxy/code-map/MAP.md'), 'utf8')).toContain('## .NET projects');
  } finally {
    await app.close();
  }
});

test('Go workspace indexes package aliases, declared receivers and conservative interface calls', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-map-go-')), 'go-project');
  await cp(resolve('tests/fixtures/code-map/go-workspace'), project, { recursive: true });
  const { app, win } = await launchApp({ project });
  try {
    const id = await activeProjectId(win);
    await win.evaluate((projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: true }), id);
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
              state: string;
            }
          ).state,
      )
      .toBe('ready');
    const graph = JSON.parse(await readFile(join(project, '.oxy/code-map/graph.json'), 'utf8')) as {
      symbols: { id: string; name: string }[];
      edges: { to: string; rel: string }[];
      unresolved: { target: string; reason: string }[];
    };
    const save = graph.symbols.find((s) => s.name === 'Save' && s.id.includes('method:Save@Store'))!;
    expect(graph.edges.filter((e) => e.to === save.id && e.rel === 'calls')).toHaveLength(2);
    expect(graph.unresolved).toContainEqual(
      expect.objectContaining({ target: 'w.Save', reason: 'interface-dispatch' }),
    );
    await win.locator(`[data-project-id="${id}"]`).click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    await win.getByTestId('project-settings-tab-code-map').click();
    await expect(win.getByTestId('code-map-language-go')).toContainText('go: Calls');
    await expect(win.getByTestId('code-map-language-go')).toContainText('Interface dispatch');
    expect(await readFile(join(project, '.oxy/code-map/MAP.md'), 'utf8')).toContain('build tags');
  } finally {
    await app.close();
  }
});

test('Java Maven modules expose declared receiver calls, inheritance and explicit overload ambiguity', async () => {
  const project = join(await mkdtemp(join(tmpdir(), 'oxy-map-java-')), 'java-project');
  await cp(resolve('tests/fixtures/code-map/java-maven'), project, { recursive: true });
  const { app, win } = await launchApp({ project });
  try {
    const id = await activeProjectId(win);
    await win.evaluate((projectId) => window.oxy.invoke('codeMap:setEnabled', { projectId, enabled: true }), id);
    await expect
      .poll(
        async () =>
          (
            (await win.evaluate((projectId) => window.oxy.invoke('codeMap:getStatus', { projectId }), id)) as {
              state: string;
            }
          ).state,
      )
      .toBe('ready');
    const graph = JSON.parse(await readFile(join(project, '.oxy/code-map/graph.json'), 'utf8')) as {
      groups: { kind?: string }[];
      edges: { rel: string }[];
      unresolved: { target: string; reason: string }[];
    };
    expect(graph.edges.filter((e) => e.rel === 'calls')).toHaveLength(10);
    expect(graph.groups.filter((g) => g.kind === 'project')).toHaveLength(3);
    expect(graph.unresolved).toContainEqual(expect.objectContaining({ target: 'same', reason: 'ambiguous-overload' }));
    await win.locator(`[data-project-id="${id}"]`).click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    await win.getByTestId('project-settings-tab-code-map').click();
    await expect(win.getByTestId('code-map-language-java')).toContainText('java: Calls');
    expect(await readFile(join(project, '.oxy/code-map/MAP.md'), 'utf8')).toContain('ambiguous same-arity overloads');
  } finally {
    await app.close();
  }
});

test('MCP Code Map tools see edits, report access and disappear after disabling', async () => {
  const project = await mkdtemp(join(tmpdir(), 'oxy-map-mcp-'));
  await writeFile(join(project, 'api.ts'), 'export function beforeEdit() {}\n');
  const { app, win, userData } = await launchApp({ project });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const id = await activeProjectId(win),
      port = await freePort();
    await win.evaluate((port) => window.oxy.invoke('settings:update', { 'mcp.enabled': true, 'mcp.port': port }), port);
    await win.locator(`[data-project-id="${id}"]`).click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    await win.getByTestId('project-settings-tab-code-map').click();
    await expect(win.getByTestId('code-map-mcp-status')).toContainText('enable Code Map');
    await win.getByTestId('code-map-enabled').click();
    await win
      .getByRole('alertdialog', { name: 'Enable Code Map?' })
      .getByRole('button', { name: 'Enable Code Map', exact: true })
      .click();
    await expect(win.getByTestId('code-map-state')).toHaveText('Ready', { timeout: 20000 });
    await expect(win.getByTestId('code-map-mcp-status')).toContainText('available');
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    client = await connect(port, token);
    expect(await client.tools()).toContain('oxy_find_code');
    expect(
      (await client.call('oxy_find_code', { query: 'beforeEdit', cwd: project })).result?.content?.[0]?.text,
    ).toContain('beforeEdit');
    await writeFile(join(project, 'api.ts'), 'export function afterEdit() {}\n');
    const found = await client.call('oxy_find_code', { query: 'afterEdit', cwd: project });
    expect(found.result?.content?.[0]?.text).toContain('afterEdit');
    expect(found.result?.content?.[0]?.text).toContain('"stale":false');
    expect(
      (await client.call('oxy_file_outline', { path: 'api.ts', cwd: project })).result?.content?.[0]?.text,
    ).toContain('afterEdit');
    await win.getByTestId('code-map-enabled').click();
    // Refused either by the call's own opt-in check or, once the list changed, as an unknown tool.
    await expect
      .poll(async () => {
        const refused = await client!.call('oxy_find_code', { query: 'afterEdit', cwd: project });
        return refused.result?.isError === true || refused.error !== undefined;
      })
      .toBe(true);
    await expect.poll(() => client!.tools()).not.toContain('oxy_find_code');
    await win.evaluate(() => window.oxy.invoke('settings:update', { 'mcp.enabled': false }));
    await expect(win.getByTestId('code-map-mcp-status')).toContainText('enable Code Map');
    await expect(win.getByRole('button', { name: 'Configure Agent Tools' })).toBeVisible();
  } finally {
    client?.close();
    await app.close();
  }
});

test('instruction buttons preserve CLAUDE.md and remove a newly created AGENTS.md without enabling indexing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'oxy-map-instructions-'));
  const original = '\ufeff# Project rules\r\n';
  await writeFile(join(project, 'CLAUDE.md'), original);
  const { app, win } = await launchApp({ project });
  try {
    const id = await activeProjectId(win);
    await win.locator(`[data-project-id="${id}"]`).click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    await win.getByTestId('project-settings-tab-code-map').click();
    const add = win.getByRole('button', { name: 'Add to CLAUDE.md', exact: true });
    await add.click();
    await expect(add).toBeEnabled();
    await add.click();
    await expect.poll(() => readFile(join(project, 'CLAUDE.md'), 'utf8')).toContain('oxy_find_code');
    expect((await readFile(join(project, 'CLAUDE.md'), 'utf8')).match(/oxytocin:code-map:start/g)).toHaveLength(1);
    await win.getByRole('button', { name: 'Remove from CLAUDE.md', exact: true }).click();
    await expect.poll(() => readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe(original);
    await win.getByRole('button', { name: 'Add to AGENTS.md', exact: true }).click();
    await expect.poll(() => readFile(join(project, 'AGENTS.md'), 'utf8').catch(() => '')).toContain('oxy_find_code');
    await win.getByRole('button', { name: 'Remove from AGENTS.md', exact: true }).click();
    await expect
      .poll(() =>
        stat(join(project, 'AGENTS.md')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await expect(win.getByTestId('code-map-state')).toHaveText('Disabled');
    await expect(stat(join(project, '.oxy'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await app.close();
  }
});
