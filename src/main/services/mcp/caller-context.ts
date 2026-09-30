import type { McpCallContext } from '@shared/domain/mcp';
import { fromShellPath, isAbsolutePath } from '@shared/utils/shell-path';

export interface CallerProject {
  id: string;
  name: string;
  rootPath: string;
}

export interface CallerDeps {
  terminal(id: string): { id: string; projectId: string; agentId?: string } | undefined;
  projects(): CallerProject[];
  activeProjectId(): string | null;
  /** The project containing a path (longest root wins). */
  findByPath(path: string): CallerProject | undefined;
  /** Real path (8.3 short names, symlinks and junctions resolved), null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  platform: string;
}

export interface CallerInput {
  /** `X-Oxytocin-Terminal` header: a hint, not a security boundary (a literal `${…}` means it was not expanded). */
  terminalHeader?: string;
  args: Record<string, unknown>;
}

export interface ResolvedCaller {
  context: McpCallContext;
  /** Why an explicit `project` or `cwd` argument did not select a project (tools that need one report it). */
  projectError?: string;
  /** "Terminal title · Project" for the call log. */
  label?: string;
}

const listProjects = (projects: CallerProject[]) =>
  projects.map((p) => `${p.name} (${p.rootPath})`).join(', ') || 'none';

/** The project containing a path an agent reported, in any spelling (Git Bash, WSL, short names, symlinks). */
export async function projectByPath(deps: CallerDeps, path: string): Promise<CallerProject | undefined> {
  const converted = fromShellPath(path.trim(), deps.platform);
  if (!isAbsolutePath(converted, deps.platform)) return undefined;
  const direct = deps.findByPath(converted);
  if (direct) return direct;
  const real = await deps.realpath(converted);
  return real ? deps.findByPath(real) : undefined;
}

/**
 * Which terminal, project and agent a tool call comes from. In order: an explicit `project` argument (name, id or
 * folder), the terminal named by the `X-Oxytocin-Terminal` header, a `cwd` argument, the active project, the only
 * project.
 */
export async function resolveCaller(deps: CallerDeps, input: CallerInput): Promise<ResolvedCaller> {
  const header = input.terminalHeader?.trim();
  const terminal = header ? deps.terminal(header) : undefined;
  const terminalPart: McpCallContext = terminal
    ? { terminalId: terminal.id, ...(terminal.agentId ? { agentId: terminal.agentId } : {}) }
    : {};
  const projects = deps.projects();
  const done = (project: CallerProject, extra: Partial<ResolvedCaller> = {}): ResolvedCaller => ({
    context: { ...terminalPart, projectId: project.id },
    label: project.name,
    ...extra,
  });

  const wanted = input.args['project'];
  if (typeof wanted === 'string' && wanted.trim()) {
    const name = wanted.trim();
    const found =
      (await projectByPath(deps, name)) ??
      projects.find((p) => p.id === name) ??
      projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (found) return done(found);
    return {
      context: terminalPart,
      projectError: `No open project "${name}". Open projects: ${listProjects(projects)}.`,
    };
  }
  if (terminal) {
    const project = projects.find((p) => p.id === terminal.projectId);
    if (project) return done(project);
  }
  const cwd = input.args['cwd'];
  if (typeof cwd === 'string' && cwd.trim()) {
    const found = await projectByPath(deps, cwd);
    if (found) return done(found);
    return {
      context: terminalPart,
      projectError: `${cwd} is not inside a project open in Oxytocin. Open projects: ${listProjects(projects)}.`,
    };
  }
  const activeId = deps.activeProjectId();
  const active = activeId ? projects.find((p) => p.id === activeId) : undefined;
  if (active) return done(active);
  if (projects.length === 1) return done(projects[0]!);
  return { context: terminalPart };
}

/** The message for tools that need a project when none could be chosen. */
export const NO_PROJECT_MESSAGE = 'Pass `cwd` (your working directory) or `project` to choose an Oxytocin project.';
