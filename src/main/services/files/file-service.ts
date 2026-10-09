import type { FileContent, FileEntry, FileList, FileStat, FileWriteRequest } from '@shared/domain/files';
import type { Project } from '@shared/domain/project';
import type { Settings } from '@shared/domain/settings';
import { OxyError } from '@shared/errors';
import type { WorkspaceHostEvents, WorkspaceHostMethods } from '@shared/rpc/contracts/workspace-host';
import type { UtilityHost } from '../../hosts/utility-host';

export interface FileServiceDeps {
  host: Pick<UtilityHost<WorkspaceHostMethods, WorkspaceHostEvents>, 'call'>;
  project: (id: string) => Pick<Project, 'rootPath' | 'missing'> | undefined;
  settings: () => Settings;
  /** Moves a file or folder to the trash (Electron's `shell.trashItem`). */
  trash: (absolutePath: string) => Promise<void>;
}

/** Files Quick Open lists at most. */
const FIND_LIMIT = 100_000;

/**
 * Project files for the built-in code editor and the FILES section. The renderer names a project and a relative
 * path; the project's folder comes from the project list, so no request reaches outside a project.
 */
export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  private root(projectId: string): string {
    const project = this.deps.project(projectId);
    if (!project) throw new OxyError('NOT_FOUND', `Unknown project ${projectId}`);
    if (project.missing) throw new OxyError('NOT_FOUND', 'The project folder is missing');
    return project.rootPath;
  }

  private gitPath(): string {
    return this.deps.settings()['git.path'] ?? 'git';
  }

  list(projectId: string, path: string): Promise<FileEntry[]> {
    return this.deps.host.call('files:list', { root: this.root(projectId), path, gitPath: this.gitPath() });
  }

  find(projectId: string): Promise<FileList> {
    return this.deps.host.call('files:find', {
      root: this.root(projectId),
      gitPath: this.gitPath(),
      ignoredFolders: this.deps.settings()['git.ignoredFolders'],
      limit: FIND_LIMIT,
    });
  }

  stat(projectId: string, path: string): Promise<FileStat | null> {
    return this.deps.host.call('files:stat', { root: this.root(projectId), path });
  }

  read(projectId: string, path: string): Promise<FileContent> {
    const maxBytes = Math.round(this.deps.settings()['editor.code.maxFileSizeMb'] * 1024 * 1024);
    return this.deps.host.call('files:read', { root: this.root(projectId), path, maxBytes });
  }

  write(req: FileWriteRequest): Promise<FileStat> {
    return this.deps.host.call('files:write', {
      root: this.root(req.projectId),
      path: req.path,
      content: req.content,
      ...(req.bom ? { bom: true } : {}),
      ...(req.expectedMtimeMs !== undefined ? { expectedMtimeMs: req.expectedMtimeMs } : {}),
    });
  }

  create(projectId: string, path: string, kind: 'file' | 'dir'): Promise<void> {
    return this.deps.host.call('files:create', { root: this.root(projectId), path, kind });
  }

  rename(projectId: string, from: string, to: string): Promise<void> {
    return this.deps.host.call('files:rename', { root: this.root(projectId), from, to });
  }

  async trash(projectId: string, path: string): Promise<void> {
    if (!path) throw new OxyError('INVALID', 'The project folder cannot be deleted here.');
    const root = this.root(projectId);
    const sep = root.includes('\\') ? '\\' : '/';
    await this.deps.trash(`${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`);
  }
}
