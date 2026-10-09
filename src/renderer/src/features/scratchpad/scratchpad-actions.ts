import { scratchpadText, withScratchpadText } from '@shared/domain/ui-state';
import { useProjectsStore } from '../../stores/projects-store';
import { useUiStore } from '../../stores/ui-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';
import { revealTerminal } from '../attention/reveal';
import { getActiveTerminalId } from '../terminals/terminal-actions';
import { terminalRegistry } from '../terminals/terminal-registry';
import { type AgentTarget, agentTargets, resolveAgentTarget, sanitizeForPaste } from './send-target';

/** Agent chosen in the scratchpad's target menu (cleared when that terminal goes away). */
let chosenTargetId: string | null = null;

export function chooseAgentTarget(terminalId: string | null): void {
  chosenTargetId = terminalId;
}

export function currentAgentTargets(): AgentTarget[] {
  const { projects, activeId } = useProjectsStore.getState();
  return agentTargets(useTerminalsStore.getState().terminals, projects, activeId);
}

export function currentAgentTarget(targets = currentAgentTargets()): AgentTarget | null {
  return resolveAgentTarget(targets, chosenTargetId, getActiveTerminalId());
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

/**
 * Pastes `text` into the agent's terminal (bracketed paste when the agent enabled it, so multi-line prompts
 * are not submitted line by line) and focuses it. The prompt is not submitted unless `submit` is set: the user
 * reviews it and presses Enter.
 */
export async function sendToAgent(
  target: AgentTarget,
  text: string,
  opts: { submit?: boolean } = {},
): Promise<boolean> {
  const safe = sanitizeForPaste(text);
  if (!safe.trim()) return false;
  const revealed = await revealTerminal(target.projectId, target.terminalId);
  const deadline = performance.now() + 3000;
  let entry = terminalRegistry.get(target.terminalId);
  while (!entry && performance.now() < deadline) {
    await nextFrame();
    entry = terminalRegistry.get(target.terminalId);
  }
  if (!revealed || !entry) {
    notify('error', 'The agent terminal is not available');
    return false;
  }
  entry.term.paste(safe);
  entry.focus();
  if (opts.submit) {
    // Agents read a paste as a whole before Enter submits it.
    await new Promise((r) => setTimeout(r, 150));
    entry.sendRaw('\r');
  }
  return true;
}

/** Appends text to the scratchpad the user sees now (a blank line apart from what is there). */
export function appendToScratchpad(text: string): void {
  const ui = useUiStore.getState();
  const { activeId, projects } = useProjectsStore.getState();
  const current = scratchpadText(ui.state.scratchpad, activeId);
  const next = current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text;
  const known = projects.length > 0 ? projects.map((p) => p.id) : undefined;
  ui.setScratchpad(withScratchpadText(ui.state.scratchpad, activeId, next, known));
}
