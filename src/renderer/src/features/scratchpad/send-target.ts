import type { Project } from '@shared/domain/project';
import type { TerminalInfo } from '@shared/domain/terminal';

export interface AgentTarget {
  terminalId: string;
  projectId: string;
  /** "<project> · <terminal title>" (the project is omitted for the active one). */
  label: string;
  inActiveProject: boolean;
}

/** A running terminal started as an agent or with an agent detected in its process tree. */
export function isAgentTerminal(t: TerminalInfo): boolean {
  return t.state === 'running' && (t.kind === 'agent' || t.agent !== undefined);
}

/** Agent terminals the scratchpad can send to: the active project's first, then by creation time. */
export function agentTargets(
  terminals: Readonly<Record<string, TerminalInfo>>,
  projects: readonly Pick<Project, 'id' | 'name'>[],
  activeProjectId: string | null,
): AgentTarget[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return Object.values(terminals)
    .filter((t) => isAgentTerminal(t) && names.has(t.projectId))
    .sort(
      (a, b) =>
        Number(b.projectId === activeProjectId) - Number(a.projectId === activeProjectId) || a.createdAt - b.createdAt,
    )
    .map((t) => {
      const inActiveProject = t.projectId === activeProjectId;
      const title = t.agent?.displayName && t.title === t.profileName ? t.agent.displayName : t.title;
      return {
        terminalId: t.id,
        projectId: t.projectId,
        label: inActiveProject ? title : `${names.get(t.projectId)} · ${title}`,
        inActiveProject,
      };
    });
}

/**
 * The agent "Send to agent" pastes into without asking: the explicitly chosen one, else the last focused agent
 * terminal, else the only agent (in the active project, or overall). `null` means the user has to pick.
 */
export function resolveAgentTarget(
  targets: readonly AgentTarget[],
  chosenId: string | null,
  lastFocusedId: string | null,
): AgentTarget | null {
  const byId = (id: string | null) => (id ? targets.find((t) => t.terminalId === id) : undefined);
  const explicit = byId(chosenId) ?? byId(lastFocusedId);
  if (explicit) return explicit;
  if (targets.length === 1) return targets[0]!;
  const local = targets.filter((t) => t.inActiveProject);
  return local.length === 1 ? local[0]! : null;
}
