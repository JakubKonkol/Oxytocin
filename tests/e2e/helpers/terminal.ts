import { expect, type Page } from '@playwright/test';

interface OxyTest {
  terminalIds(): string[];
  getTerminalText(id: string): string | null;
  getTerminalSize(id: string): { cols: number; rows: number } | null;
  selectText(id: string, text: string): boolean;
  getTextColor(id: string, text: string): { fg: number; palette: boolean; rgb: boolean; default: boolean } | null;
}

export const oxyTest = (page: Page) => ({
  terminalIds: () => page.evaluate(() => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.terminalIds()),
  text: (id: string) =>
    page.evaluate((i) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.getTerminalText(i) ?? '', id),
  size: (id: string) =>
    page.evaluate((i) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.getTerminalSize(i), id),
  select: (id: string, text: string) =>
    page.evaluate(([i, t]) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.selectText(i, t), [
      id,
      text,
    ] as const),
  color: (id: string, text: string) =>
    page.evaluate(([i, t]) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.getTextColor(i, t), [
      id,
      text,
    ] as const),
});

/** Waits for the first terminal of the default area and its shell prompt; returns its id. */
export async function waitForTerminal(page: Page): Promise<string> {
  const panel = page.getByTestId('terminal-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const id = (await panel.getAttribute('data-terminal-id'))!;
  await expect.poll(() => oxyTest(page).text(id), { timeout: 15_000 }).not.toBe('');
  return id;
}

/** Types a command line into the focused terminal. */
export async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** A `node -e` command line that works in bash, zsh, pwsh and cmd (no shell-specific quoting inside). */
export const nodeCmd = (script: string) => `node -e "${script}"`;
