import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

const previewFrames = (win: Page) =>
  win.frames().filter((f) => f.url().startsWith('oxy-plugin://oxytocin.markdown-preview/') && !f.isDetached());

async function previewFor(win: Page, path: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const f of previewFrames(win)) {
          const p = await f.evaluate(() => document.body.dataset['path']).catch(() => undefined);
          if (p === path) found = f;
        }
        return !!found;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return found!;
}

/** Ctrl(+Shift)+click on the `offset`-th character after `marker` in the terminal output. */
async function clickLink(win: Page, id: string, marker: string, offset: number, shift = false): Promise<void> {
  const t = oxyTest(win);
  // Previews open as tabs of the terminal's group: bring the terminal to the front first.
  const panel = (await t.workspace())!.panels.find((p) => p.terminalId === id)!;
  await win.getByTestId(`tab-${panel.id}`).click();
  await expect(win.getByTestId(`terminal-view-${id}`)).toBeVisible();
  const start = (await t.position(id, marker))!;
  const next = (await t.position(id, marker.slice(1)))!;
  const x = start.x + (next.x - start.x) * offset;
  await win.mouse.move(x, start.y);
  await win.waitForTimeout(300);
  await win.keyboard.down('Control');
  if (shift) await win.keyboard.down('Shift');
  await win.mouse.move(x + 1, start.y);
  await win.waitForTimeout(200);
  await win.mouse.click(x + 1, start.y);
  if (shift) await win.keyboard.up('Shift');
  await win.keyboard.up('Control');
}

const pluginPanels = async (win: Page) =>
  ((await oxyTest(win).workspace())?.panels ?? []).filter((p) => p.id.startsWith('plg-')).length;

test('terminal file links open a preview tab (Markdown rendered, code highlighted) that can move to the right sidebar', async () => {
  test.setTimeout(120_000);
  const { app, win, project, userData } = await launchApp();
  try {
    await writeFile(join(project!, 'CLAUDE.md'), '# Instructions\n\n## Atrybuty OT\n\n- keep it simple\n');
    await mkdir(join(project!, 'src'));
    await writeFile(
      join(project!, 'src/app.ts'),
      "export const a = 1;\nexport const b = 2;\nexport function third(): string {\n  return 'three';\n}\n",
    );
    const id = await waitForTerminal(win);
    // Typographic quotes around the name, like an agent's summary.
    await run(
      win,
      nodeCmd(
        "console.log('PRE' + 'VIEW \\u201eAtrybuty\\u201d w CLAUDE.md: gotowe'); console.log('CO' + 'DE src/app.ts:3')",
      ),
    );
    await expect.poll(() => oxyTest(win).text(id)).toContain('CODE src/app.ts:3');

    // Markdown: a new tab with the rendered file.
    await clickLink(win, id, 'PREVIEW „Atrybuty” w CLAUDE.md', 21);
    const md = await previewFor(win, 'CLAUDE.md');
    await expect(win.locator('.dv-tab').filter({ hasText: 'CLAUDE.md' })).toHaveCount(1);
    await expect.poll(() => md.evaluate(() => document.querySelector('h2')?.textContent)).toBe('Atrybuty OT');

    // Code: highlighted, with line numbers, scrolled to and marking line 3.
    await clickLink(win, id, 'CODE src/app.ts:3', 6);
    const code = await previewFor(win, join('src', 'app.ts'));
    await expect.poll(() => code.evaluate(() => document.body.dataset['line'])).toBe('3');
    expect(await code.evaluate(() => document.getElementById('content')!.dataset['kind'])).toBe('code');
    expect(await code.evaluate(() => document.querySelectorAll('.code-view .line').length)).toBe(5);
    expect(await code.evaluate(() => document.querySelector('.line-highlight')?.textContent)).toContain(
      'function third',
    );
    expect(await code.evaluate(() => document.querySelector('.code-view')!.className)).toContain('shiki');
    expect(await pluginPanels(win)).toBe(2);

    // The same file again: the open tab is reused.
    await clickLink(win, id, 'PREVIEW „Atrybuty” w CLAUDE.md', 21);
    await win.waitForTimeout(500);
    expect(await pluginPanels(win)).toBe(2);

    // Ctrl+Shift+click opens the editor instead.
    await clickLink(win, id, 'CODE src/app.ts:3', 6, true);
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { __oxyMain: { editor: { recorded: unknown[] } } }).__oxyMain.editor.recorded,
        ),
      )
      .toEqual([expect.objectContaining({ line: 3 })]);

    // Move the code preview into the right sidebar; a link to it reveals it there instead of opening a tab.
    await win.locator('.dv-tab').filter({ hasText: 'app.ts' }).click({ button: 'right' });
    await win.getByText('Move to right sidebar').click();
    const sidebar = win.getByTestId('secondary-sidebar');
    await expect(sidebar.getByTestId('sidebar-tool-markdown.preview')).toBeVisible();
    expect(await pluginPanels(win)).toBe(1);
    await previewFor(win, join('src', 'app.ts'));
    await clickLink(win, id, 'CODE src/app.ts:3', 6);
    await win.waitForTimeout(500);
    expect(await pluginPanels(win)).toBe(1);

    // Live reload of a code preview.
    await writeFile(join(project!, 'src/app.ts'), 'export const changed = true;\n');
    const sidebarCode = await previewFor(win, join('src', 'app.ts'));
    await expect
      .poll(() => sidebarCode.evaluate(() => document.getElementById('content')!.textContent))
      .toContain('changed');
  } finally {
    await app.close();
  }

  // Both previews come back after a restart: the tab in the workspace, the tool in the right sidebar.
  const ui = JSON.parse(await readFile(join(userData, 'ui-state.json'), 'utf8')) as {
    secondaryTools: { panelType?: string }[];
  };
  expect(ui.secondaryTools.map((t) => t.panelType)).toContain('markdown.preview');
  const again = await launchApp({ userData });
  try {
    await waitForTerminal(again.win);
    await previewFor(again.win, 'CLAUDE.md');
    await expect(again.win.locator('.dv-tab').filter({ hasText: 'CLAUDE.md' })).toHaveCount(1);
    await expect(again.win.getByTestId('secondary-sidebar').getByTestId('sidebar-tool-markdown.preview')).toBeVisible();
  } finally {
    await again.app.close();
  }
});
