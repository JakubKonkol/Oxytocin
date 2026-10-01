import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { OxytocinApi, PluginContext, PluginView, ProjectInfo } from '@oxytocin/plugin-api';
import { type DetectedProfile, type DetectFs, detectProfiles } from './detect';
import { McpServer } from './mcp';
import { fromShellPath, pathCandidates } from './paths';
import { buildTools, LEGACY_TOOL_NAMES, type RunnerTools } from './tools';
import {
  emptyConfig,
  findProfile,
  mergeProfiles,
  normalizeConfig,
  overrideFor,
  type ProfileInput,
  type ProjectRunConfig,
  type RunProfile,
  validateProfileInput,
} from './profiles';
import type { RunnerState } from '../shared/types';
import { RunManager, type RunSnapshot, type StartedBy, type TerminalLink } from './runner';

export const PANEL_TYPE = 'projectRunner.panel';
const STATUS_ITEM = 'projectRunner.status';
const DETECT_TTL_MS = 30_000;
const MAX_READ_BYTES = 1024 * 1024;

/** Node file system facade for detection, rooted at a project folder. */
export function nodeDetectFs(root: string): DetectFs {
  const abs = (rel: string) => (rel ? join(root, ...rel.split('/')) : root);
  return {
    async list(rel) {
      try {
        const entries = await readdir(abs(rel), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    async readText(rel) {
      try {
        const path = abs(rel);
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_READ_BYTES) return null;
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

class RunnerService {
  readonly runs: RunManager;
  /** The old `oxytocin-runner` server (see mcp.ts): only for installs that used it before Oxytocin had its own. */
  readonly legacyMcp: McpServer;
  private readonly views = new Set<PluginView>();
  private readonly detected = new Map<string, { at: number; profiles: DetectedProfile[] }>();
  private readonly scanning = new Map<string, Promise<DetectedProfile[]>>();
  private active: ProjectInfo | undefined;
  /** Bumped by project events: a list fetched before an event must not overwrite what the event said. */
  private projectEvents = 0;
  private projects: ProjectInfo[] = [];
  /** Resolves when the service knows the projects (views and tools wait for it). */
  ready: Promise<void> = Promise.resolve();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: PluginContext) {
    const { oxy } = ctx;
    this.runs = new RunManager({
      terminals: oxy.terminals,
      log: (message, error) => ctx.log.debug(message, error),
    });
    this.legacyMcp = new McpServer(
      {
        name: 'oxytocin-runner',
        version: ctx.plugin.version,
        instructions:
          'Run profiles of the projects open in Oxytocin (dev servers, APIs, workers). Pass your current working directory as `cwd` so the right project is used. Apps started here are visible to the user in Oxytocin’s Run panel and terminals. This server is replaced by Oxytocin’s own MCP server "oxytocin" (tools run_*); the user connects it in Oxytocin under Settings → Agent Tools.',
      },
      () => this.ctx.storage.get<string>('mcpToken') ?? '',
    );
    this.legacyMcp.setTools(buildTools(this.toolsPort(), LEGACY_TOOL_NAMES));
  }

  /** The tools for Oxytocin's MCP server (`contributes.mcp`, prefix `run`). */
  mcpTools() {
    return buildTools(this.toolsPort());
  }

  private get oxy(): OxytocinApi {
    return this.ctx.oxy;
  }

  // ── lifecycle ──

  init(): Promise<void> {
    this.ready = this.initialize();
    return this.ready;
  }

  private async initialize(): Promise<void> {
    const { oxy } = this;
    const subs = this.ctx.subscriptions;
    // Subscribe first: a project activated while the lists are fetched (start-up) must not be missed.
    subs.push(
      oxy.projects.onDidChange((list) => {
        this.projectEvents++;
        this.projects = list;
        for (const id of [...this.detected.keys()]) if (!list.some((p) => p.id === id)) this.detected.delete(id);
        this.pushAll();
      }),
      oxy.projects.onDidChangeActive((p) => {
        this.projectEvents++;
        this.active = p;
        this.pushAll();
        this.notifyPrompts();
      }),
      oxy.terminals.onDidChange((meta) => this.runs.onTerminalChange(meta)),
      oxy.terminals.onDidClose(({ id }) => this.runs.onTerminalClose(id)),
      this.runs.onDidChange((projectId) => {
        this.push(projectId);
        this.scheduleStatus();
        this.scheduleSaveLinks();
        this.notifyPrompts();
      }),
      oxy.settings.onDidChange('projectRunner.mcp', () => void this.applyLegacyMcp()),
      this.runs,
      { dispose: () => void this.legacyMcp.stop() },
      { dispose: () => this.notifiedPrompts.forEach((controller) => controller?.abort()) },
    );
    const before = this.projectEvents;
    const [projects, active] = await Promise.all([oxy.projects.list(), oxy.projects.getActive()]);
    if (this.projectEvents === before) {
      this.projects = projects;
      this.active = active;
    }
    await this.adoptTerminals().catch((e: unknown) => this.ctx.log.warn('Adopting running apps failed', e));
    await this.applyLegacyMcp();
    this.updateStatus();
  }

  private linksTimer: ReturnType<typeof setTimeout> | undefined;

  /** Remembers which terminal runs which profile (debounced). */
  private scheduleSaveLinks(): void {
    clearTimeout(this.linksTimer);
    this.linksTimer = setTimeout(() => {
      void this.ctx.storage
        .set('terminals', this.runs.terminalLinks())
        .catch((e: unknown) => this.ctx.log.warn('Saving the run terminals failed', e));
    }, 200);
  }

  /** Apps started before the plugin (re)started — a Plugin Host restart, a reload, re-enabling it — are taken over. */
  private async adoptTerminals(): Promise<void> {
    const links = this.ctx.storage.get<TerminalLink[]>('terminals');
    if (!Array.isArray(links) || links.length === 0) return;
    const alive = new Map((await this.oxy.terminals.list()).map((t) => [t.id, t]));
    for (const link of links) {
      const meta = alive.get(link?.terminalId);
      const project = meta ? this.project(link.projectId) : undefined;
      if (!meta || !project) continue;
      const profile = (await this.profiles(project)).find((p) => p.id === link.profileId);
      if (profile) this.runs.adopt(project.id, profile, meta, link.setup);
    }
  }

  private mcpQueue: Promise<void> = Promise.resolve();

  /**
   * Starts, moves or stops the old `oxytocin-runner` server per the deprecated `projectRunner.mcp.*` settings;
   * serialized. It runs only where it ran before (a token exists), so earlier Claude Code registrations keep working.
   */
  applyLegacyMcp(): Promise<void> {
    this.mcpQueue = this.mcpQueue.then(async () => {
      const enabled = this.oxy.settings.get<boolean>('projectRunner.mcp.enabled') !== false;
      const port = this.oxy.settings.get<number>('projectRunner.mcp.port') || 47286;
      if (!enabled || !this.ctx.storage.get<string>('mcpToken')) await this.legacyMcp.stop();
      else if (this.legacyMcp.port !== port) {
        await this.legacyMcp
          .start(port)
          .catch((e: unknown) =>
            this.ctx.log.warn(`The old MCP server could not start: ${this.legacyMcp.error ?? String(e)}`),
          );
      }
    });
    return this.mcpQueue;
  }

  // ── projects and profiles ──

  project(id: string): ProjectInfo | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** The project a view shows: its own (a workspace panel) or the active one (sidebars). */
  private async projectOf(view: PluginView): Promise<ProjectInfo | undefined> {
    await this.ready;
    if (view.projectId) {
      if (!this.project(view.projectId)) this.projects = await this.oxy.projects.list();
      const own = this.project(view.projectId);
      if (own) return own;
    }
    return this.active ?? (this.active = await this.oxy.projects.getActive());
  }

  private config(projectId: string): ProjectRunConfig {
    return normalizeConfig(this.ctx.storage.get(`project:${projectId}`) ?? emptyConfig());
  }

  private async saveConfig(projectId: string, config: ProjectRunConfig): Promise<void> {
    await this.ctx.storage.set(`project:${projectId}`, config);
  }

  async detect(project: ProjectInfo, force = false): Promise<DetectedProfile[]> {
    const cached = this.detected.get(project.id);
    if (!force && cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.profiles;
    const running = this.scanning.get(project.id);
    if (running) return running;
    const depth = this.oxy.settings.get<number>('projectRunner.scanDepth') ?? 3;
    const scan = detectProfiles(nodeDetectFs(project.rootPath), {
      platform: this.oxy.env.platform,
      maxDepth: depth,
      rootName: project.name,
    })
      .catch((e: unknown) => {
        this.ctx.log.warn(`Detecting apps in ${project.rootPath} failed`, e);
        return [] as DetectedProfile[];
      })
      .then((profiles) => {
        this.detected.set(project.id, { at: Date.now(), profiles });
        this.scanning.delete(project.id);
        return profiles;
      });
    this.scanning.set(project.id, scan);
    this.push(project.id);
    return scan;
  }

  async profiles(project: ProjectInfo): Promise<RunProfile[]> {
    const merged = mergeProfiles(await this.detect(project), this.config(project.id));
    this.runs.forgetMissing(project.id, new Set(merged.map((p) => p.id)));
    return merged;
  }

  async profileOrThrow(project: ProjectInfo, idOrName: string): Promise<RunProfile> {
    const profile = findProfile(await this.profiles(project), idOrName);
    if (!profile) throw new Error(`No run profile "${idOrName}" in ${project.name}.`);
    return profile;
  }

  async saveProfile(project: ProjectInfo, id: string | undefined, input: ProfileInput): Promise<RunProfile> {
    const valid = validateProfileInput(input);
    const config = this.config(project.id);
    const detected = (await this.detect(project)).find((d) => d.id === id);
    if (detected) {
      const override = overrideFor(detected, valid);
      if (override) config.overrides[detected.id] = override;
      else delete config.overrides[detected.id];
    } else {
      const existing = config.custom.findIndex((p) => p.id === id);
      const profile: RunProfile = {
        id: existing >= 0 && id ? id : `custom-${randomBytes(4).toString('hex')}`,
        ...valid,
        kind: 'custom',
        source: 'custom',
      };
      if (existing >= 0) config.custom[existing] = profile;
      else config.custom.push(profile);
      id = profile.id;
    }
    await this.saveConfig(project.id, config);
    this.push(project.id);
    return (await this.profiles(project)).find((p) => p.id === (detected?.id ?? id))!;
  }

  async deleteProfile(project: ProjectInfo, id: string): Promise<void> {
    const config = this.config(project.id);
    if (config.custom.some((p) => p.id === id)) config.custom = config.custom.filter((p) => p.id !== id);
    else if (!config.hidden.includes(id)) config.hidden.push(id);
    delete config.overrides[id];
    await this.saveConfig(project.id, config);
    this.push(project.id);
  }

  async resetProfiles(project: ProjectInfo, id?: string): Promise<void> {
    const config = this.config(project.id);
    if (id) delete config.overrides[id];
    else {
      config.hidden = [];
      config.overrides = {};
    }
    await this.saveConfig(project.id, config);
    this.push(project.id);
  }

  // ── running ──

  async start(project: ProjectInfo, profile: RunProfile, by: StartedBy): Promise<RunSnapshot> {
    return this.runs.start(project.rootPath, project.id, profile, by);
  }

  async restart(project: ProjectInfo, profile: RunProfile, by: StartedBy): Promise<RunSnapshot> {
    return this.runs.restart(project.rootPath, project.id, profile, by);
  }

  // ── views ──

  async state(project: ProjectInfo | undefined): Promise<RunnerState> {
    const profiles = project ? await this.profiles(project) : [];
    return {
      type: 'state',
      project: project ? { id: project.id, name: project.name, rootPath: project.rootPath } : null,
      profiles: profiles.map((p) => ({ ...p, run: this.runs.snapshot(project!.id, p.id) })),
      scanning: project ? this.scanning.has(project.id) : false,
    };
  }

  /** Sends a view its current state (failures are logged: the view keeps its last state). */
  private async send(view: PluginView, onlyProject?: string): Promise<void> {
    try {
      const project = await this.projectOf(view);
      if (onlyProject !== undefined && project?.id !== onlyProject) return;
      await view.postMessage(await this.state(project));
    } catch (e) {
      this.ctx.log.warn('Updating a Run view failed', e);
    }
  }

  private push(projectId: string): void {
    for (const view of this.views) void this.send(view, projectId);
  }

  private pushAll(): void {
    for (const view of this.views) void this.send(view);
  }

  private async withProject<T>(view: PluginView, run: (project: ProjectInfo) => Promise<T>): Promise<T> {
    const project = await this.projectOf(view);
    if (!project) throw new Error('Open a project first.');
    return run(project);
  }

  attach(view: PluginView): void {
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
    // Opened on screen: it asks the open questions of its project itself.
    if (view.visible) queueMicrotask(() => this.notifyPrompts());
    view.onRequest('load', async () => this.state(await this.projectOf(view)));
    view.onRequest<{ profileId: string }, RunSnapshot>('start', ({ profileId }) =>
      this.withProject(view, async (p) => this.start(p, await this.profileOrThrow(p, profileId), 'user')),
    );
    view.onRequest<{ profileId: string }, RunSnapshot>('restart', ({ profileId }) =>
      this.withProject(view, async (p) => this.restart(p, await this.profileOrThrow(p, profileId), 'user')),
    );
    view.onRequest<{ profileId: string }, RunSnapshot>('stop', ({ profileId }) =>
      this.withProject(view, (p) => this.runs.stop(p.id, profileId)),
    );
    view.onRequest<{ profileId: string }, boolean>('logs', ({ profileId }) =>
      this.withProject(view, (p) => this.runs.showLogs(p.id, profileId)),
    );
    view.onRequest<{ profileId: string; text: string; promptId?: number }, RunSnapshot>(
      'answer',
      ({ profileId, text, promptId }) => {
        if (typeof text !== 'string' || text.length > 1000) throw new Error('Invalid answer.');
        return this.withProject(view, (p) => this.runs.answer(p.id, profileId, text, promptId));
      },
    );
    view.onRequest<{ url: string }, void>('openUrl', async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses can be opened.');
      await this.oxy.ui.openExternal(url);
    });
    view.onRequest<{ id?: string; input: ProfileInput }, RunProfile>('save', ({ id, input }) =>
      this.withProject(view, (p) => this.saveProfile(p, id, input)),
    );
    view.onRequest<{ profileId: string }, void>('delete', ({ profileId }) =>
      this.withProject(view, (p) => this.deleteProfile(p, profileId)),
    );
    view.onRequest<{ profileId?: string }, void>('reset', ({ profileId }) =>
      this.withProject(view, (p) => this.resetProfiles(p, profileId)),
    );
    view.onRequest('rescan', () =>
      this.withProject(view, async (p) => {
        await this.detect(p, true);
        this.push(p.id);
      }),
    );
    view.onRequest('openAgentTools', () => this.oxy.commands.execute('oxytocin.mcp.openSettings'));
    view.onDidChangeVisibility((visible) => {
      if (!visible) return;
      void this.send(view);
      // The view now asks the open questions itself.
      this.notifyPrompts();
    });
  }

  // ── questions of starting apps ──

  /** Questions already announced (prompt id → the toast, until it is answered, withdrawn or no longer shown). */
  private readonly notifiedPrompts = new Map<number, AbortController | null>();

  /** A Run view on screen shows the project's runs, questions included. */
  private shownInView(projectId: string): boolean {
    return [...this.views].some((v) => v.visible && (v.projectId ?? this.active?.id) === projectId);
  }

  /**
   * An app that asks something while starting (Angular's "Port 4200 is already in use… (Y/n)") would look like it
   * hangs: tell the user once per question, with the answers and a way to its terminal. Not when a Run view on
   * screen already asks it; the toast closes once the question is answered (here or in the view), goes away, or a
   * Run view shows it, so no button is left that does nothing.
   */
  private notifyPrompts(): void {
    const open = new Set<number>();
    for (const run of this.runs.active()) {
      const prompt = run.prompt;
      if (!prompt) continue;
      open.add(prompt.id);
      const shown = this.shownInView(run.projectId);
      if (this.notifiedPrompts.has(prompt.id)) {
        if (shown) this.withdrawPrompt(prompt.id);
        continue;
      }
      if (shown) {
        this.notifiedPrompts.set(prompt.id, null);
        continue;
      }
      const controller = new AbortController();
      this.notifiedPrompts.set(prompt.id, controller);
      const project = this.project(run.projectId);
      const name = `${run.name ?? run.profileId}${project ? ` (${project.name})` : ''}`;
      void this.oxy.ui
        .showNotification({
          level: 'warning',
          message: `${name} is waiting for your answer`,
          detail: prompt.text,
          actions: [
            ...(prompt.yesNo
              ? [
                  { id: 'yes', title: 'Yes' },
                  { id: 'no', title: 'No' },
                ]
              : []),
            { id: 'show', title: 'Show Terminal' },
          ],
          signal: controller.signal,
        })
        .then(async (action) => {
          if (action === 'yes' || action === 'no')
            await this.runs.answer(run.projectId, run.profileId, action === 'yes' ? 'y' : 'n', prompt.id);
          else if (action === 'show') await this.runs.showLogs(run.projectId, run.profileId);
        })
        .catch((e: unknown) => this.ctx.log.warn('Answering a run prompt failed', e));
    }
    for (const id of [...this.notifiedPrompts.keys()]) {
      if (open.has(id)) continue;
      this.withdrawPrompt(id);
      this.notifiedPrompts.delete(id);
    }
  }

  /** Closes the toast of a question (it stays announced: it is not shown again). */
  private withdrawPrompt(id: number): void {
    this.notifiedPrompts.get(id)?.abort();
    if (this.notifiedPrompts.has(id)) this.notifiedPrompts.set(id, null);
  }

  // ── status bar ──

  private scheduleStatus(): void {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.updateStatus(), 50);
  }

  private updateStatus(): void {
    const item = this.oxy.ui.statusBarItem(STATUS_ITEM);
    const active = this.runs.active();
    if (active.length === 0) {
      item.hide();
      return;
    }
    // Amber while an app is still starting or stopping, or waits for an answer.
    const settling = active.some((r) => r.status !== 'running' || r.prompt);
    const asking = active.filter((r) => r.prompt).length;
    item.text = `$(play) ${active.length} running${asking ? ` · ${asking} waiting for input` : ''}`;
    item.color = settling ? 'warning' : 'success';
    item.tooltip = active
      .map((r) => {
        const project = this.project(r.projectId);
        const status = r.prompt ? `waiting for input: ${r.prompt.text.replace(/\s+/g, ' ')}` : r.status;
        return `${project ? `${project.name}: ` : ''}${r.name ?? r.profileId} — ${status}${r.url ? ` (${r.url})` : ''}`;
      })
      .join('\n');
    item.command = 'projectRunner.show';
    item.show();
  }

  // ── MCP tools ──

  /** The project containing a path an agent reported (any spelling: short names, symlinks, Git Bash paths). */
  private async findByPath(path: string): Promise<ProjectInfo | undefined> {
    for (const candidate of await pathCandidates(path, this.oxy.env.platform)) {
      const found = await this.oxy.projects.findByPath(candidate);
      if (found) return found;
    }
    return undefined;
  }

  private toolsPort(): RunnerTools {
    return {
      resolveProject: async ({ project, cwd }, context) => {
        const projects = (this.projects = await this.oxy.projects.list());
        const explicit = (typeof project === 'string' && project.trim()) || (typeof cwd === 'string' && cwd.trim());
        // Oxytocin's server knows the caller's project (its terminal, else the active project).
        const fromCaller =
          !explicit && context?.projectId ? projects.find((p) => p.id === context.projectId) : undefined;
        if (fromCaller) return fromCaller;
        if (typeof project === 'string' && project.trim()) {
          const wanted = project.trim();
          const byPath = isAbsolute(fromShellPath(wanted, this.oxy.env.platform))
            ? await this.findByPath(wanted)
            : undefined;
          const found =
            byPath ??
            projects.find((p) => p.id === wanted) ??
            projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
          if (!found)
            throw new Error(`No open project "${wanted}". Open projects: ${projects.map((p) => p.name).join(', ')}.`);
          return found;
        }
        if (typeof cwd === 'string' && cwd.trim()) {
          const found = await this.findByPath(cwd);
          if (found) return found;
          throw new Error(
            `${cwd} is not inside a project open in Oxytocin. Open projects: ${projects.map((p) => `${p.name} (${p.rootPath})`).join(', ') || 'none'}.`,
          );
        }
        const active = await this.oxy.projects.getActive();
        if (active) return active;
        if (projects.length === 1) return projects[0]!;
        throw new Error('Pass `cwd` (your working directory) or `project` to choose a project.');
      },
      profiles: (p) => this.profiles(p),
      profile: (p, id) => this.profileOrThrow(p, id),
      snapshot: (p, id) => this.runs.snapshot(p.id, id),
      start: (p, profile) => this.start(p, profile, 'agent'),
      restart: (p, profile) => this.restart(p, profile, 'agent'),
      stop: (p, id) => this.runs.stop(p.id, id),
      waitFor: (p, id, done, ms) => this.runs.waitFor(p.id, id, done, ms),
      logs: (p, id, lines) => this.runs.logs(p.id, id, lines),
      answer: (p, id, text) => this.runs.answer(p.id, id, text),
      addProfile: (p, input) => this.saveProfile(p, undefined, input),
    };
  }
}

let service: RunnerService | undefined;

export async function activate(ctx: PluginContext): Promise<void> {
  const { oxy } = ctx;
  service = new RunnerService(ctx);
  const s = service;
  // Started before the providers exist: views resolved meanwhile wait for it (`ready`).
  const initialized = s.init();
  const provider = { resolve: (view: PluginView) => s.attach(view) };
  ctx.subscriptions.push(
    oxy.ui.registerPanelProvider(PANEL_TYPE, provider),
    oxy.commands.register('projectRunner.show', () => oxy.ui.openPanel(PANEL_TYPE, { placement: 'right' })),
    oxy.commands.register('projectRunner.run', async () => {
      const project = await oxy.projects.getActive();
      if (!project) {
        void oxy.ui.showNotification({ level: 'info', message: 'Open a project first.' });
        return;
      }
      const profiles = await s.profiles(project);
      if (profiles.length === 0) {
        void oxy.ui.showNotification({
          level: 'info',
          message: `No runnable apps found in ${project.name}. Add a run profile in the Run panel.`,
        });
        return;
      }
      const picked = await oxy.ui.showQuickPick(
        profiles.map((p) => ({
          label: p.name,
          description: p.framework ? `${p.framework} · ${p.command}` : p.command,
          ...(p.cwd ? { detail: p.cwd } : {}),
          id: p.id,
        })),
        { placeholder: `Run an app of ${project.name}` },
      );
      if (!picked) return;
      const profile = profiles.find((p) => p.id === picked.id)!;
      await s.start(project, profile, 'user');
    }),
    oxy.commands.register('projectRunner.stopAll', async () => {
      await Promise.all(s.runs.active().map((r) => s.runs.stop(r.projectId, r.profileId)));
    }),
    // For Oxytocin's project resources: an API's base URL can come from a run profile.
    oxy.commands.register('oxytocin.project-runner.resolveUrl', (arg: unknown) => {
      const { projectId, profileId } = (arg ?? {}) as { projectId?: unknown; profileId?: unknown };
      if (typeof projectId !== 'string' || typeof profileId !== 'string') return null;
      const run = s.runs.snapshot(projectId, profileId);
      return (run.status === 'running' || run.status === 'starting') && run.url ? run.url : null;
    }),
    oxy.commands.register('oxytocin.project-runner.profiles', async (arg: unknown) => {
      const projectId = (arg ?? {}) && typeof arg === 'object' ? (arg as { projectId?: unknown }).projectId : undefined;
      const project = (await oxy.projects.list()).find((p) => p.id === projectId);
      if (!project) return [];
      return (await s.profiles(project)).map((p) => ({ id: p.id, name: p.name, ...(p.url ? { url: p.url } : {}) }));
    }),
  );
  // Agents run the apps through Oxytocin's MCP server (`contributes.mcp`, prefix `run`).
  for (const tool of s.mcpTools())
    ctx.subscriptions.push(oxy.mcp.registerTool(tool.name, (args, context) => tool.handler(args, context)));
  await initialized;
}

export function deactivate(): void {
  service = undefined;
}
