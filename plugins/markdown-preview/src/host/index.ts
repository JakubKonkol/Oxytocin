import { type FSWatcher, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Logger, OxytocinApi, PluginContext, PluginView, ProjectInfo } from '@oxytocin/plugin-api';
import { renderFile } from './render';
import { listMarkdownFiles } from './files';

export const PANEL_TYPE = 'markdown.preview';
const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'];
const WATCH_DEBOUNCE_MS = 150;
const CHANGED_BADGE_MS = 3000;

/** Backend → view messages (also the response of the view's `load` request). */
export type PreviewMessage =
  { type: 'render'; html: string; path: string; changed: boolean } | { type: 'error'; message: string };

export interface PreviewParams {
  projectId?: string;
  /** Absolute path of the Markdown file. */
  path?: string;
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/** Whether `path` lies inside `root` (case-insensitive on Windows/macOS). */
export function isInside(root: string, path: string, insensitive = caseInsensitive): boolean {
  const norm = (p: string) => (insensitive ? p.toLowerCase() : p);
  const rel = relative(norm(resolve(root)), norm(resolve(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export const isMarkdown = (path: string) => MARKDOWN_EXTENSIONS.includes(extname(path).toLowerCase());

/** Where a link in the preview points: `external` (http/https), a project `file`, or nowhere usable. */
export function resolveLink(
  href: string,
  filePath: string,
  rootPath: string,
): { kind: 'external'; url: string } | { kind: 'file'; path: string } | { kind: 'invalid' } {
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return { kind: 'invalid' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.replace(/[?#].*$/, ''));
  } catch {
    return { kind: 'invalid' };
  }
  if (!decoded) return { kind: 'invalid' };
  const target = decoded.startsWith('/') ? join(rootPath, decoded) : resolve(dirname(filePath), decoded);
  return isInside(rootPath, target) ? { kind: 'file', path: target } : { kind: 'invalid' };
}

/** One open preview: renders its file, watches it and answers the view's requests. */
class Preview {
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private badgeTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private lastHtml: string | undefined;
  private dirty = false;

  constructor(
    private readonly view: PluginView,
    private readonly oxy: OxytocinApi,
    private readonly log: Logger,
    private readonly project: ProjectInfo,
    private readonly filePath: string,
  ) {}

  start(): void {
    this.view.title = basename(this.filePath);
    this.view.onRequest('load', () => this.render(false));
    this.view.onRequest<{ href: string }, boolean>('openLink', ({ href }) => this.openLink(href));
    this.view.onDidChangeVisibility((visible) => {
      if (visible && this.dirty) this.schedule();
    });
    this.view.onDidDispose(() => this.dispose());
    try {
      const name = basename(this.filePath);
      this.watcher = watch(dirname(this.filePath), (_event, filename) => {
        const changed = filename?.toString();
        if (!changed || (caseInsensitive ? changed.toLowerCase() === name.toLowerCase() : changed === name))
          this.schedule();
      });
      this.watcher.on('error', (e) => this.log.warn(`Watching ${this.filePath} failed`, e));
    } catch (e) {
      this.log.warn(`Cannot watch ${this.filePath}`, e);
    }
  }

  private schedule(): void {
    if (!this.view.visible) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      void this.render(true).then((msg) => {
        if (msg) void this.view.postMessage(msg);
      });
    }, WATCH_DEBOUNCE_MS);
  }

  /** Renders the file; for live updates resolves undefined when nothing changed or a newer render won. */
  private async render(live: boolean): Promise<PreviewMessage | undefined> {
    const seq = ++this.seq;
    let msg: PreviewMessage;
    try {
      const html = await renderFile(this.filePath, this.project.rootPath);
      if (live && html === this.lastHtml) return undefined;
      this.lastHtml = html;
      msg = { type: 'render', html, path: relative(this.project.rootPath, this.filePath), changed: live };
    } catch (e) {
      this.lastHtml = undefined;
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      msg = {
        type: 'error',
        message: missing ? 'File not found — it was deleted or moved.' : `Could not render the file: ${String(e)}`,
      };
    }
    if (seq !== this.seq) return live ? undefined : msg;
    if (live && msg.type === 'render') {
      this.view.badge = { text: 'changed' };
      clearTimeout(this.badgeTimer);
      this.badgeTimer = setTimeout(() => (this.view.badge = undefined), CHANGED_BADGE_MS);
    }
    return msg;
  }

  private async openLink(href: string): Promise<boolean> {
    const target = resolveLink(href, this.filePath, this.project.rootPath);
    if (target.kind === 'external') {
      await this.oxy.ui.openExternal(target.url);
      return true;
    }
    if (target.kind === 'invalid') return false;
    const exists = await stat(target.path).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!exists) {
      void this.oxy.ui.showNotification({
        level: 'warning',
        message: `File not found: ${relative(this.project.rootPath, target.path)}`,
      });
      return false;
    }
    if (isMarkdown(target.path)) await openPreview(this.oxy, this.project, target.path);
    else await this.oxy.ui.openInEditor(target.path);
    return true;
  }

  private dispose(): void {
    clearTimeout(this.debounce);
    clearTimeout(this.badgeTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

function openPreview(oxy: OxytocinApi, project: ProjectInfo, path: string): Promise<void> {
  return oxy.ui.openPanel(PANEL_TYPE, { projectId: project.id, params: { projectId: project.id, path } });
}

async function findProject(oxy: OxytocinApi, params: PreviewParams, fallbackId?: string) {
  const projects = await oxy.projects.list();
  const id = params.projectId ?? fallbackId;
  return id ? projects.find((p) => p.id === id) : undefined;
}

export function activate(ctx: PluginContext): void {
  const { oxy, log } = ctx;

  ctx.subscriptions.push(
    oxy.ui.registerPanelProvider(PANEL_TYPE, {
      async resolve(view) {
        const params = (view.params ?? {}) as PreviewParams;
        const project = await findProject(oxy, params, view.projectId);
        let problem: string | undefined;
        if (!project) problem = 'The project of this preview is not open.';
        else if (typeof params.path !== 'string' || !isAbsolute(params.path)) problem = 'No file to preview.';
        else if (!isInside(project.rootPath, params.path)) problem = 'The file is outside the project folder.';
        if (problem || !project || !params.path) {
          view.onRequest('load', (): PreviewMessage => ({ type: 'error', message: problem ?? 'No file to preview.' }));
          return;
        }
        new Preview(view, oxy, log, project, params.path).start();
      },
    }),
  );

  ctx.subscriptions.push(
    oxy.commands.register('markdown.openPreview', async (arg?: unknown) => {
      const active = await oxy.projects.getActive();
      let path: string | undefined;
      let project: ProjectInfo | undefined;
      if (typeof arg === 'string' && arg) {
        path = isAbsolute(arg) ? arg : active ? resolve(active.rootPath, arg) : undefined;
        project = path ? await oxy.projects.findByPath(path) : undefined;
      } else if (active) {
        // Without an argument: pick one of the project's Markdown files in the command palette.
        const files = await listMarkdownFiles(active.rootPath);
        if (files.length === 0) {
          void oxy.ui.showNotification({ level: 'info', message: 'No Markdown files in the active project.' });
          return;
        }
        const picked = await oxy.ui.showQuickPick(
          files.map((f) => {
            const slash = f.relativePath.lastIndexOf('/');
            return {
              label: f.relativePath.slice(slash + 1),
              ...(slash > 0 ? { description: f.relativePath.slice(0, slash) } : {}),
              path: f.path,
            };
          }),
          { placeholder: 'Open a Markdown preview' },
        );
        if (!picked) return;
        path = picked.path;
        project = active;
      }
      if (!path || !project || !isInside(project.rootPath, path)) {
        void oxy.ui.showNotification({
          level: 'warning',
          message:
            typeof arg === 'string' ? `Not a file of an open project: ${arg}` : 'Open a project to preview its files.',
        });
        return;
      }
      await openPreview(oxy, project, path);
    }),
  );
}
