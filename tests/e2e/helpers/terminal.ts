import { expect, type Page } from '@playwright/test';

export interface WorkspaceSnapshot {
  groups: number;
  maximized: boolean;
  activeGroup: { id: string; width: number; height: number } | null;
  activePanelId: string | null;
  panels: { id: string; group: string; terminalId: string | null; floating: boolean }[];
}

interface OxyTest {
  openPluginPanel(panelType: string, params?: unknown): Promise<string | null>;
  diff(panelId: string): { original: string; modified: string; changes: number } | null;
  code(panelId: string): { text: string; dirty: boolean; path: string } | null;
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
  code: (panelId: string) =>
    page.evaluate((id) => (window as unknown as { __oxyTest: OxyTest }).__oxyTest.code(id), panelId),
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

const PROMPT_END = /[>$#%]\s*$/;

/**
 * Whether a terminal is ready for typed input: its shell reported a prompt (shell integration), or its text ends
 * like a prompt (a shell without integration, an agent's input line). Keys typed before that can be lost (PowerShell's
 * PSReadLine drops them) or echoed twice.
 */
async function promptShown(page: Page, id: string): Promise<boolean> {
  const info = (
    (await page.evaluate(() => window.oxy.invoke('terminals:list'))) as { id: string; shellIntegration?: boolean }[]
  ).find((t) => t.id === id);
  if (info?.shellIntegration) return true;
  return PROMPT_END.test((await oxyTest(page).text(id)).trimEnd());
}

/**
 * Waits for the n-th terminal panel (default: the first), its first output and, for up to 15 s, its prompt (see
 * `promptShown`; a terminal that never shows one is returned once the time is up). Returns its id.
 */
export async function waitForTerminal(page: Page, index = 0): Promise<string> {
  const panel = page.locator('[data-terminal-id]').nth(index);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const id = (await panel.getAttribute('data-terminal-id'))!;
  await expect.poll(() => oxyTest(page).text(id), { timeout: 15_000 }).not.toBe('');
  await expect
    .poll(() => promptShown(page, id), { timeout: 15_000 })
    .toBe(true)
    .catch(() => undefined);
  return id;
}

/** Types a command line into the focused terminal. */
export async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** Waits until the terminal shows a shell prompt (keys typed earlier may be echoed twice or lost). */
export async function waitForPrompt(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => PROMPT_END.test((await oxyTest(page).text(id)).trimEnd()), { timeout: 15_000 })
    .toBe(true);
}

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
