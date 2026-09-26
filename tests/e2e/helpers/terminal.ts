import { expect, type Page } from '@playwright/test';

export interface WorkspaceSnapshot {
  groups: number;
  maximized: boolean;
  activeGroup: { id: string; width: number; height: number } | null;
  activePanelId: string | null;
  panels: { id: string; group: string; terminalId: string | null }[];
}

interface OxyTest {
  openPluginPanel(panelType: string, params?: unknown): Promise<string | null>;
  diff(panelId: string): { original: string; modified: string; changes: number } | null;
  activeTerminalId(): string | null;
  workspace(): WorkspaceSnapshot | null;
  movePanel(panelId: string, targetPanelId: string): boolean;
  terminalIds(): string[];
  getTerminalText(id: string): string | null;
  getTerminalSize(id: string): { cols: number; rows: number } | null;
  selectText(id: string, text: string): boolean;
  textPosition(id: string, text: string): { x: number; y: number } | null;
  getTextColor(id: string, text: string): { fg: number; palette: boolean; rgb: boolean; default: boolean } | null;
}

export const oxyTest = (page: Page) => ({
  activeTerminalId: () =>
    page.evaluate(() => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.activeTerminalId()),
  workspace: () => page.evaluate(() => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.workspace()),
  movePanel: (panelId: string, targetPanelId: string) =>
    page.evaluate(([a, b]) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.movePanel(a, b), [
      panelId,
      targetPanelId,
    ] as const),
  openPluginPanel: (panelType: string, params?: unknown) =>
    page.evaluate(([t, p]) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.openPluginPanel(t, p), [
      panelType,
      params,
    ] as const),
  diff: (panelId: string) =>
    page.evaluate((id) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.diff(id), panelId),
  terminalIds: () => page.evaluate(() => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.terminalIds()),
  text: (id: string) =>
    page.evaluate((i) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.getTerminalText(i) ?? '', id),
  size: (id: string) =>
    page.evaluate((i) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.getTerminalSize(i), id),
  position: (id: string, text: string) =>
    page.evaluate(([i, t]) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.textPosition(i, t), [
      id,
      text,
    ] as const),
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

/** Waits for the n-th terminal panel (default: the first) and its shell prompt; returns its id. */
export async function waitForTerminal(page: Page, index = 0): Promise<string> {
  const panel = page.locator('[data-terminal-id]').nth(index);
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

const PROMPT_END = /[>$#%]\s*$/;

/**
 * Presses Ctrl+C and waits for the shell's next prompt: PowerShell (PSReadLine) drops keys typed before it
 * redraws the prompt after an interrupt.
 */
export async function interrupt(page: Page, id: string): Promise<void> {
  const before = await oxyTest(page).text(id);
  await page.keyboard.press('Control+C');
  await expect
    .poll(async () => {
      const text = (await oxyTest(page).text(id)).trimEnd();
      return text !== before.trimEnd() && PROMPT_END.test(text);
    })
    .toBe(true);
  await page.waitForTimeout(300);
}

/** A `node -e` command line that works in bash, zsh, pwsh and cmd (no shell-specific quoting inside). */
export const nodeCmd = (script: string) => `node -e "${script}"`;

/** Id of the active project. */
export async function activeProjectId(page: Page): Promise<string> {
  const { id } = (await page.evaluate(() => window.oxy.invoke('projects:getActive'))) as { id: string | null };
  if (!id) throw new Error('No active project');
  return id;
}
