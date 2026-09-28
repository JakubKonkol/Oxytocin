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
import { RunManager, type RunSnapshot, type StartedBy } from './runner';

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
  private projects: ProjectInfo[] = [];
  private claudeConnected: boolean | null = null;
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

  async init(): Promise<void> {
    const { oxy } = this;
    this.projects = await oxy.projects.list();
    this.active = await oxy.projects.getActive();
    const subs = this.ctx.subscriptions;
    subs.push(
      oxy.projects.onDidChange((list) => {
        this.projects = list;
        for (const id of [...this.detected.keys()]) if (!list.some((p) => p.id === id)) this.detected.delete(id);
        this.pushAll();
      }),
      oxy.projects.onDidChangeActive((p) => {
        this.active = p;
        this.pushAll();
      }),
      oxy.terminals.onDidChange((meta) => this.runs.onTerminalChange(meta)),
      oxy.terminals.onDidClose(({ id }) => this.runs.onTerminalClose(id)),
      this.runs.onDidChange((projectId) => {
        this.push(projectId);
        this.scheduleStatus();
      }),
      oxy.settings.onDidChange('projectRunner.mcp', () => void this.applyMcpSettings()),
      this.runs,
      { dispose: () => void this.mcp.stop() },
    );
    await this.applyMcpSettings();
    this.updateStatus();
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

  async applyMcpSettings(): Promise<void> {
    const enabled = this.oxy.settings.get<boolean>('projectRunner.mcp.enabled') !== false;
    if (!enabled) await this.mcp.stop();
    else if (this.mcp.port !== this.mcpPort()) {
      this.token();
      await this.mcp
        .start(this.mcpPort())
        .catch((e: unknown) => this.ctx.log.warn(`MCP server could not start: ${this.mcp.error ?? String(e)}`));
    }
    this.pushAll();
  }

  // ── projects and profiles ──

  project(id: string): ProjectInfo | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** The project a view shows: its own (a workspace panel) or the active one (sidebars). */
  private projectOf(view: PluginView): ProjectInfo | undefined {
    return (view.projectId ? this.project(view.projectId) : undefined) ?? this.active;
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

  private push(projectId: string): void {
    for (const view of this.views) {
      if (this.projectOf(view)?.id !== projectId) continue;
      void this.state(this.projectOf(view)).then((s) => view.postMessage(s));
    }
  }

  private pushAll(): void {
    for (const view of this.views) void this.state(this.projectOf(view)).then((s) => view.postMessage(s));
  }

  private withProject<T>(view: PluginView, run: (project: ProjectInfo) => Promise<T>): Promise<T> {
    const project = this.projectOf(view);
    if (!project) return Promise.reject(new Error('Open a project first.'));
    return run(project);
  }

  attach(view: PluginView): void {
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
    view.onRequest('load', () => this.state(this.projectOf(view)));
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
      if (visible) void this.state(this.projectOf(view)).then((s) => view.postMessage(s));
    });
  }

  async checkClaude(): Promise<boolean | null> {
    this.claudeConnected = await isConnectedToClaude(this.cli);
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
    const failedStart = active.some((r) => r.status === 'starting');
    item.text = `$(play) ${active.length} running`;
    item.color = failedStart ? 'warning' : 'success';
    item.tooltip = active
      .map((r) => {
        const project = this.project(r.projectId);
        return `${project ? `${project.name}: ` : ''}${r.profileId.replace(/^\w+:/, '')} — ${r.status}${r.url ? ` (${r.url})` : ''}`;
      })
      .join('\n');
    item.command = 'projectRunner.show';
    item.show();
  }

  // ── MCP tools ──

  private toolsPort(): RunnerTools {
    return {
      resolveProject: async ({ project, cwd }) => {
        const projects = (this.projects = await this.oxy.projects.list());
        if (typeof project === 'string' && project.trim()) {
          const wanted = project.trim();
          const byPath = isAbsolute(wanted) ? await this.oxy.projects.findByPath(wanted) : undefined;
          const found =
            byPath ??
            projects.find((p) => p.id === wanted) ??
            projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
          if (!found)
            throw new Error(`No open project "${wanted}". Open projects: ${projects.map((p) => p.name).join(', ')}.`);
          return found;
        }
        if (typeof cwd === 'string' && cwd.trim()) {
          const found = await this.oxy.projects.findByPath(cwd.trim());
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
  await s.init();
  void s.checkClaude();
}

export function deactivate(): void {
  service = undefined;
}
