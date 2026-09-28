import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { OxytocinApi, PluginContext, PluginView, ProjectInfo } from '@oxytocin/plugin-api';
import {
  addCommandLine,
  connectClaude,
  createCliRunner,
  disconnectClaude,
  isConnectedToClaude,
  mcpConfigJson,
  type RunCli,
} from './claude';
import { type DetectedProfile, type DetectFs, detectProfiles } from './detect';
import { McpServer } from './mcp';
import { fromShellPath, pathCandidates } from './paths';
import { buildTools, type RunnerTools } from './tools';
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
export const VIEW_ID = 'projectRunner.sidebar';
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
  readonly mcp: McpServer;
  private readonly views = new Set<PluginView>();
  private readonly detected = new Map<string, { at: number; profiles: DetectedProfile[] }>();
  private readonly scanning = new Map<string, Promise<DetectedProfile[]>>();
  private active: ProjectInfo | undefined;
  /** Bumped by project events: a list fetched before an event must not overwrite what the event said. */
  private projectEvents = 0;
  private projects: ProjectInfo[] = [];
  /** Resolves when the service knows the projects (views and tools wait for it). */
  ready: Promise<void> = Promise.resolve();
  private claudeConnected: boolean | null = null;
  private claudeChecked: Promise<boolean | null> | undefined;
  private readonly cli: RunCli;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: PluginContext) {
    const { oxy } = ctx;
    this.runs = new RunManager({
      terminals: oxy.terminals,
      log: (message, error) => ctx.log.debug(message, error),
    });
    this.cli = createCliRunner(() => oxy.settings.get<string>('projectRunner.claudeCommand') || 'claude');
    this.mcp = new McpServer(
      {
        name: 'oxytocin-runner',
        version: ctx.plugin.version,
        instructions:
          'Run profiles of the projects open in Oxytocin (dev servers, APIs, workers). Pass your current working directory as `cwd` so the right project is used. Apps started here are visible to the user in Oxytocin’s Run panel and terminals.',
      },
      () => this.token(),
    );
    this.mcp.setTools(buildTools(this.toolsPort()));
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
      }),
      oxy.terminals.onDidChange((meta) => this.runs.onTerminalChange(meta)),
      oxy.terminals.onDidClose(({ id }) => this.runs.onTerminalClose(id)),
      this.runs.onDidChange((projectId) => {
        this.push(projectId);
        this.scheduleStatus();
        this.scheduleSaveLinks();
      }),
      oxy.settings.onDidChange('projectRunner.mcp', () => void this.applyMcpSettings()),
      this.runs,
      { dispose: () => void this.mcp.stop() },
    );
    const before = this.projectEvents;
    const [projects, active] = await Promise.all([oxy.projects.list(), oxy.projects.getActive()]);
    if (this.projectEvents === before) {
      this.projects = projects;
      this.active = active;
    }
    await this.adoptTerminals().catch((e: unknown) => this.ctx.log.warn('Adopting running apps failed', e));
    await this.applyMcpSettings();
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

  private token(): string {
    let token = this.ctx.storage.get<string>('mcpToken');
    if (!token) {
      token = randomBytes(24).toString('base64url');
      void this.ctx.storage.set('mcpToken', token);
    }
    return token;
  }

  private mcpPort(): number {
    return this.oxy.settings.get<number>('projectRunner.mcp.port') || 47286;
  }

  private mcpQueue: Promise<void> = Promise.resolve();

  /** Starts, moves or stops the MCP server per the settings; serialized (quick toggles must not overlap). */
  applyMcpSettings(): Promise<void> {
    this.mcpQueue = this.mcpQueue.then(async () => {
      const enabled = this.oxy.settings.get<boolean>('projectRunner.mcp.enabled') !== false;
      if (!enabled) await this.mcp.stop();
      else if (this.mcp.port !== this.mcpPort()) {
        this.token();
        await this.mcp
          .start(this.mcpPort())
          .catch((e: unknown) => this.ctx.log.warn(`MCP server could not start: ${this.mcp.error ?? String(e)}`));
      }
      this.pushAll();
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
      mcp: {
        enabled: this.oxy.settings.get<boolean>('projectRunner.mcp.enabled') !== false,
        port: this.mcp.port,
        error: this.mcp.error,
        claude: this.claudeConnected,
        calls: this.mcp.calls,
      },
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
    // Asked once, when a Run view first shows (it runs the `claude` CLI).
    this.claudeChecked ??= this.checkClaude().catch(() => null);
    view.onDidDispose(() => this.views.delete(view));
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
    view.onRequest('connectClaude', () => this.connectClaude());
    view.onRequest('disconnectClaude', async () => {
      const r = await disconnectClaude(this.cli);
      this.claudeConnected = r.ok ? false : this.claudeConnected;
      this.pushAll();
      return r;
    });
    view.onRequest('checkClaude', () => this.checkClaude());
    view.onRequest('mcpConfig', () => ({
      command: addCommandLine(this.mcpPort(), this.token()),
      json: mcpConfigJson(this.mcpPort(), this.token()),
    }));
    view.onDidChangeVisibility((visible) => {
      if (visible) void this.send(view);
    });
  }

  async checkClaude(): Promise<boolean | null> {
    this.claudeConnected = await isConnectedToClaude(this.cli, this.mcpPort());
    this.pushAll();
    return this.claudeConnected;
  }

  async connectClaude(): Promise<{ ok: boolean; output: string }> {
    if (this.mcp.port === null) {
      return {
        ok: false,
        output: this.mcp.error ?? 'The MCP server is turned off ("projectRunner.mcp.enabled" in Settings).',
      };
    }
    const r = await connectClaude(this.cli, this.mcp.port, this.token());
    if (r.ok) this.claudeConnected = true;
    this.pushAll();
    return r;
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
    // Amber while an app is still starting or stopping.
    const settling = active.some((r) => r.status !== 'running');
    item.text = `$(play) ${active.length} running`;
    item.color = settling ? 'warning' : 'success';
    item.tooltip = active
      .map((r) => {
        const project = this.project(r.projectId);
        return `${project ? `${project.name}: ` : ''}${r.name ?? r.profileId} — ${r.status}${r.url ? ` (${r.url})` : ''}`;
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
      resolveProject: async ({ project, cwd }) => {
        const projects = (this.projects = await this.oxy.projects.list());
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
    oxy.ui.registerViewProvider(VIEW_ID, provider),
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
    oxy.commands.register('projectRunner.connectClaude', async () => {
      const r = await s.connectClaude();
      void oxy.ui.showNotification({
        level: r.ok ? 'info' : 'error',
        message: r.ok
          ? 'Claude Code can now run your profiles (MCP server "oxytocin-runner").'
          : 'Connecting Claude Code failed',
        ...(r.ok ? {} : { detail: r.output }),
      });
    }),
  );
  await initialized;
}

export function deactivate(): void {
  service = undefined;
}
