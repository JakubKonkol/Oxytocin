import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Frame, type Page, test } from '@playwright/test';
import { makeRepo } from './helpers/git';
import { launchApp } from './helpers/launch';
import { nodeCmd, oxyTest, run, waitForTerminal } from './helpers/terminal';

// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const previewFrames = (win: Page) =>
  win.frames().filter((f) => f.url().startsWith('oxy-plugin://oxytocin.markdown-preview/'));

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

test('Markdown Preview: opened from CHANGES, live reload, images, links and moving without reload', async () => {
  const repo = await makeRepo();
  await mkdir(join(repo, 'docs'));
  await writeFile(join(repo, 'docs/pixel.png'), PNG);
  await writeFile(join(repo, 'docs/other.md'), '# Other document\n');
  await writeFile(
    join(repo, 'README.md'),
    [
      '# Plan',
      '',
      '- [x] step one',
      '- [ ] step two',
      '',
      '![pixel](docs/pixel.png)',
      '',
      '[Other](docs/other.md)',
      '',
      '```ts',
      'const answer: number = 42;',
      '```',
      '',
      '<script>window.__pwned = true</script>',
      '',
    ].join('\n'),
  );
  const { app, win } = await launchApp({ project: repo });
  try {
    await waitForTerminal(win);
    const section = win.getByTestId('changes-section');
    const row = section.locator('[data-testid="changes-row"][data-path="README.md"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click({ button: 'right' });
    await win.getByTestId('changes-context-menu').getByText('Open Preview').click();

    const frame = await previewFor(win, 'README.md');
    await expect(win.locator('[data-testid^="tab-plg-"]').first()).toContainText('README.md');
    const content = () => frame.evaluate(() => document.getElementById('content')!.innerHTML);
    await expect.poll(content).toContain('<h1 id="user-content-plan">Plan</h1>');
    const html = await content();
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
    expect(html).toContain('class="shiki oxytocin"');
    expect(html).not.toContain('<script');
    expect(await frame.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();

    // Move the preview into another group: the iframe keeps running (no reload).
    const t = oxyTest(win);
    const loadedAt = await frame.evaluate(() => performance.timeOrigin);
    await win.keyboard.press('Alt+Shift+Equal');
    await expect.poll(async () => (await t.workspace())?.groups).toBe(2);
    const ws = (await t.workspace())!;
    const preview = ws.panels.find((p) => p.id.startsWith('plg-'))!;
    const other = ws.panels.find((p) => p.group !== preview.group)!;
    expect(await t.movePanel(preview.id, other.id)).toBe(true);
    await expect.poll(() => frame.evaluate(() => document.visibilityState)).toBe('visible');
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(loadedAt);

    // Live reload after a write from the terminal left in the first group.
    const terminal = (await t.workspace())!.panels.find((p) => p.terminalId && p.group !== other.group)!;
    await win.getByTestId(`terminal-view-${terminal.terminalId}`).click();
    const renders = async () => Number(await frame.evaluate(() => document.body.dataset['renders']));
    const before = await renders();
    await run(win, nodeCmd("require('fs').appendFileSync('README.md', '\\n# Appended heading\\n')"));
    const typed = Date.now();
    await expect.poll(content, { timeout: 5_000, intervals: [50] }).toContain('Appended heading');
    const latency = Date.now() - typed;
    console.log(`preview refreshed ${latency} ms after the command was submitted`);
    // Includes starting node for the write; shared CI runners (Windows especially) get more headroom.
    expect(latency).toBeLessThan(process.env['CI'] ? 2_500 : 1_000);
    expect(await renders()).toBeGreaterThan(before);
    await expect(win.getByTestId('tab-plugin-badge')).toHaveText('changed');
    await expect(win.getByTestId('tab-plugin-badge')).toHaveCount(0, { timeout: 5_000 });
    expect(await frame.evaluate(() => performance.timeOrigin)).toBe(loadedAt);

    // A relative Markdown link opens another preview.
    await frame.locator('a', { hasText: 'Other' }).click();
    const other2 = await previewFor(win, join('docs', 'other.md'));
    await expect.poll(() => other2.evaluate(() => document.querySelector('h1')?.textContent)).toBe('Other document');
  } finally {
    await app.close();
  }
});
