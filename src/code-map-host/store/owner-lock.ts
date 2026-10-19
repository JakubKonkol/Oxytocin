import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodeMapOwnerSchema, type CodeMapOwner } from '@shared/domain/code-map';
import { hasCode, rejectLink } from './paths';
import { atomicWrite } from './writer';

const STALE_MS = 120_000;
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

/** Serializes claims, heartbeat replacement and release across processes. */
async function withGuard<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const guard = join(directory, 'owner.lock.guard');
  const token = randomUUID();
  const readGuard = async () => {
    try {
      return CodeMapOwnerSchema.parse(JSON.parse(await readFile(join(guard, 'claim.json'), 'utf8')));
    } catch {
      return null;
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(guard);
      await writeFile(
        join(guard, 'claim.json'),
        JSON.stringify({ instanceId: token, pid: process.pid, app: 'Oxytocin', heartbeatAt: new Date().toISOString() }),
        { flag: 'wx' },
      );
      break;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const info = await lstat(guard).catch(() => null);
      if (info?.isSymbolicLink()) throw new Error('Refusing a linked owner guard', { cause: error });
      const claim = await readGuard();
      if (info && (Date.now() - info.mtimeMs > STALE_MS || (claim && !processAlive(claim.pid)))) {
        const expired = `${guard}.tmp-${randomUUID()}`;
        await rename(guard, expired)
          .then(() => rm(expired, { recursive: true, force: true }))
          .catch((error: unknown) => {
            if (!hasCode(error, 'ENOENT')) throw error;
          });
      }
      if (attempt >= 100) throw new Error('Code Map owner lock is busy', { cause: error });
      await delay(10);
    }
  }
  try {
    return await run();
  } finally {
    // A retired map may already have a new owner at the original path.
    if ((await readGuard())?.instanceId === token) await rm(guard, { recursive: true, force: true });
  }
}

export class OwnerLock {
  private timer: ReturnType<typeof setInterval> | undefined;
  private released = false;
  private pending: Promise<void> = Promise.resolve();
  private constructor(
    readonly directory: string,
    readonly instanceId: string,
    readonly app: string,
    private readonly alive: (pid: number) => boolean,
  ) {}

  static async acquire(
    directory: string,
    app: string,
    options: { instanceId?: string; alive?: (pid: number) => boolean } = {},
  ): Promise<{ lease: OwnerLock | null; owner: CodeMapOwner | null }> {
    const instance = new OwnerLock(directory, options.instanceId ?? randomUUID(), app, options.alive ?? processAlive);
    return withGuard(directory, async () => {
      const path = join(directory, 'owner.lock');
      await rejectLink(path);
      const previous = await instance.read();
      if (previous && Date.now() - Date.parse(previous.heartbeatAt) <= STALE_MS && instance.alive(previous.pid))
        return { lease: null, owner: previous };
      if (!previous) {
        const info = await lstat(path).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT')) throw error;
          return null;
        });
        if (info && Date.now() - info.mtimeMs <= STALE_MS)
          throw new Error('Code Map owner lock is malformed; waiting for its lease to expire');
      }
      const owner = instance.current();
      await atomicWrite(path, `${JSON.stringify(owner)}\n`);
      instance.timer = setInterval(() => {
        instance.pending = instance.pending
          .then(() => instance.heartbeat())
          .catch(() => {
            instance.released = true;
            if (instance.timer) clearInterval(instance.timer);
          });
      }, 30_000);
      instance.timer.unref();
      return { lease: instance, owner };
    });
  }

  private current(): CodeMapOwner {
    return { instanceId: this.instanceId, pid: process.pid, app: this.app, heartbeatAt: new Date().toISOString() };
  }
  private async read(): Promise<CodeMapOwner | null> {
    try {
      await rejectLink(join(this.directory, 'owner.lock'));
      return CodeMapOwnerSchema.parse(JSON.parse(await readFile(join(this.directory, 'owner.lock'), 'utf8')));
    } catch (error) {
      if (
        hasCode(error, 'ENOENT') ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.name === 'ZodError')
      )
        return null;
      throw error;
    }
  }
  async assertOwned(): Promise<void> {
    const owner = await this.read();
    if (this.released || owner?.instanceId !== this.instanceId) throw new Error('Updated by another Oxytocin instance');
  }
  async heartbeat(): Promise<void> {
    await withGuard(this.directory, async () => {
      await this.assertOwned();
      await atomicWrite(join(this.directory, 'owner.lock'), `${JSON.stringify(this.current())}\n`);
    });
  }
  async dispose(): Promise<void> {
    if (this.released) return;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await withGuard(this.directory, async () => {
      const owner = await this.read();
      if (owner?.instanceId === this.instanceId) await rm(join(this.directory, 'owner.lock'), { force: true });
      this.released = true;
    });
  }
  /** Stop heartbeats and atomically retire this owner's data while claims are excluded. */
  async retire(operation: () => Promise<void>): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await withGuard(this.directory, async () => {
      await this.assertOwned();
      await operation();
      this.released = true;
    });
  }
}
