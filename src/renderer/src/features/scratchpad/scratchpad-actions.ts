import { useProjectsStore } from '../../stores/projects-store';
import { useTerminalsStore } from '../../stores/terminals-store';
import { notify } from '../../ui/Toast';
import { revealTerminal } from '../attention/reveal';
import { getActiveTerminalId } from '../terminals/terminal-actions';
import { terminalRegistry } from '../terminals/terminal-registry';
import { type AgentTarget, agentTargets, resolveAgentTarget } from './send-target';

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
 * are not submitted line by line) and focuses it. The prompt is not submitted: the user reviews and presses Enter.
 */
export async function sendToAgent(target: AgentTarget, text: string): Promise<boolean> {
  if (!text.trim()) return false;
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
  entry.term.paste(text);
  entry.focus();
  return true;
}
