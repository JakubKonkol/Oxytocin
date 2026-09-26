import { stat } from 'node:fs/promises';
import { shell } from 'electron';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';

export interface OpenRequest {
  path: string;
  line?: number;
  column?: number;
}

/**
 * "Open in editor". Until the editor presets land (M4-T5) files open with the system default app.
 * In E2E mode requests are recorded instead of launching anything.
 */
export class EditorLauncher {
  readonly recorded: OpenRequest[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly e2e: boolean,
  ) {}

  async open(req: OpenRequest): Promise<void> {
    try {
      if (!(await stat(req.path)).isFile()) throw new Error('not a file');
    } catch {
      throw new OxyError('NOT_FOUND', `File not found: ${req.path}`);
    }
    if (this.e2e) {
      this.recorded.push(req);
      return;
    }
    const error = await shell.openPath(req.path);
    if (error) {
      this.logger.warn(`Failed to open ${req.path}: ${error}`);
      throw new OxyError('SPAWN_FAILED', error);
    }
  }
}
