import type { Settings } from '@shared/domain/settings';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { cmdLine, expandArgs, parseCommandTemplate, quoteForShell, type TemplateVars } from './command-template';
import { AUTO_ORDER, EDITOR_PRESETS, type EditorPreset } from './presets';

export interface OpenRequest {
  path: string;
  line?: number;
  column?: number;
}

export type LaunchPlan =
  | { kind: 'spawn'; file: string; args: string[]; verbatim?: boolean }
  | { kind: 'system'; path: string }
  | { kind: 'terminal'; projectId: string | null; cwd: string; command: string };

export interface EditorLauncherDeps {
  settings: () => Settings;
  /** Project containing the file (root, id and its own editor command). */
  projectFor: (path: string) => { id: string; rootPath: string; editorCommand?: string } | undefined;
  which: (name: string) => Promise<string | null>;
  isFile: (path: string) => Promise<boolean>;
  spawn: (file: string, args: string[], opts: { verbatim: boolean }) => void;
  openPath: (path: string) => Promise<string>;
  openInTerminal: (req: { projectId: string | null; cwd: string; command: string }) => void;
  platform: NodeJS.Platform;
  logger: Logger;
  /** Record launches instead of running them (E2E). */
  dryRun?: boolean;
}

const dirname = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || path;

/**
 * "Open in editor" (docs/plan/09-persistence-settings.md §4): presets with `auto` detection, custom templates,
 * editors running in a new terminal panel, and the system default application. Never uses a shell for
 * spawning; `.cmd` launchers on Windows go through `cmd.exe` with strict quoting.
 */
export class EditorLauncher {
  readonly recorded: (OpenRequest & { plan: LaunchPlan })[] = [];
  private autoCache: Promise<EditorPreset | null> | undefined;
  private autoKey = '';

  constructor(private readonly deps: EditorLauncherDeps) {}

  private async findLauncher(preset: EditorPreset): Promise<string | null> {
    for (const launcher of preset.launchers) {
      const found = await this.deps.which(launcher);
      if (found) return found;
    }
    return null;
  }

  /** First installed preset in the `auto` order (cached until PATH changes). */
  detectAuto(): Promise<EditorPreset | null> {
    const key = process.env['PATH'] ?? '';
    if (!this.autoCache || key !== this.autoKey) {
      this.autoKey = key;
      this.autoCache = (async () => {
        for (const id of AUTO_ORDER) {
          const preset = EDITOR_PRESETS.find((p) => p.id === id)!;
          if (await this.findLauncher(preset)) return preset;
        }
        return null;
      })();
    }
    return this.autoCache;
  }

  private async spawnPlan(file: string, args: string[]): Promise<LaunchPlan> {
    const resolved = /[\\/]/.test(file) ? file : ((await this.deps.which(file)) ?? file);
    if (this.deps.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
      return { kind: 'spawn', file: 'cmd.exe', args: ['/d', '/s', '/c', cmdLine(resolved, args)], verbatim: true };
    }
    return { kind: 'spawn', file: resolved, args };
  }

  private async templatePlan(template: string, vars: TemplateVars): Promise<LaunchPlan> {
    const [exe, ...rest] = expandArgs(parseCommandTemplate(template), vars);
    if (!exe) return { kind: 'system', path: vars.file };
    return this.spawnPlan(exe, rest);
  }

  /** Resolves what opening `req` would do (pure except for PATH lookups). */
  async plan(req: OpenRequest): Promise<LaunchPlan> {
    const s = this.deps.settings();
    const project = this.deps.projectFor(req.path);
    const vars: TemplateVars = {
      file: req.path,
      line: req.line ?? 1,
      column: req.column ?? 1,
      projectRoot: project?.rootPath ?? dirname(req.path),
    };
    if (project?.editorCommand?.trim()) return this.templatePlan(project.editorCommand, vars);
    const preset = s['editor.preset'];
    const template = s['editor.command'].trim();
    switch (preset) {
      case 'system':
        return { kind: 'system', path: req.path };
      case 'custom':
        return template ? this.templatePlan(template, vars) : { kind: 'system', path: req.path };
      case 'terminal': {
        if (!template) return { kind: 'system', path: req.path };
        const shell = this.deps.platform === 'win32' ? 'pwsh' : 'posix';
        const command = expandArgs(parseCommandTemplate(template), vars)
          .map((a) => quoteForShell(a, shell))
          .join(' ');
        return { kind: 'terminal', projectId: project?.id ?? null, cwd: vars.projectRoot, command };
      }
      case 'auto': {
        const found = await this.detectAuto();
        if (!found) return { kind: 'system', path: req.path };
        return this.spawnPlan((await this.findLauncher(found))!, expandArgs(found.args, vars));
      }
      default: {
        const chosen = EDITOR_PRESETS.find((p) => p.id === preset);
        const launcher = chosen && (await this.findLauncher(chosen));
        if (!chosen || !launcher) {
          this.deps.logger.warn(`Editor preset ${preset} not found; opening with the system default application`);
          return { kind: 'system', path: req.path };
        }
        return this.spawnPlan(launcher, expandArgs(chosen.args, vars));
      }
    }
  }

  async open(req: OpenRequest): Promise<void> {
    if (!(await this.deps.isFile(req.path))) throw new OxyError('NOT_FOUND', `File not found: ${req.path}`);
    const plan = await this.plan(req);
    if (this.deps.dryRun) {
      this.recorded.push({ ...req, plan });
      if (plan.kind === 'terminal') this.deps.openInTerminal(plan);
      return;
    }
    switch (plan.kind) {
      case 'spawn':
        try {
          this.deps.spawn(plan.file, plan.args, { verbatim: plan.verbatim ?? false });
        } catch (e) {
          throw new OxyError(
            'SPAWN_FAILED',
            `Could not start the editor: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      case 'terminal':
        this.deps.openInTerminal(plan);
        return;
      case 'system': {
        const error = await this.deps.openPath(plan.path);
        if (error) {
          this.deps.logger.warn(`Failed to open ${plan.path}: ${error}`);
          throw new OxyError('SPAWN_FAILED', error);
        }
      }
    }
  }
}
