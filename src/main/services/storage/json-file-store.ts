import { copyFile, readFile, rename } from 'node:fs/promises';
import { readFileSync, renameSync, existsSync } from 'node:fs';
import { type ParseError, parse as parseJsonc } from 'jsonc-parser';
import type { z } from 'zod';
import type { Logger } from '@shared/logging/logger';
import { writeFileAtomic } from './atomic-write';

export type ReadStatus = 'ok' | 'missing' | 'corrupt' | 'restored-from-backup';

export interface ReadResult {
  value: unknown;
  status: ReadStatus;
  /** Path of the moved-aside corrupt file, if any. */
  corruptPath?: string;
}

export function parseJsonText(text: string, jsonc: boolean): unknown {
  if (!jsonc) return JSON.parse(text) as unknown;
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0)
    throw new SyntaxError(`Invalid JSONC (${errors.length} error(s), first at offset ${errors[0]?.offset})`);
  return value;
}

function corruptName(path: string): string {
  return `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Reads a JSON(C) file. A file that fails to parse is moved to `<file>.corrupt-<ts>` and the `.bak`
 * copy is tried instead. Synchronous variant — only for startup.
 */
export function readJsonFileSync(path: string, opts: { jsonc?: boolean } = {}): ReadResult {
  if (!existsSync(path)) return { value: undefined, status: 'missing' };
  try {
    return { value: parseJsonText(readFileSync(path, 'utf8'), opts.jsonc ?? false), status: 'ok' };
  } catch {
    const corruptPath = corruptName(path);
    try {
      renameSync(path, corruptPath);
    } catch {
      // keep going with defaults
    }
    try {
      const value = parseJsonText(readFileSync(`${path}.bak`, 'utf8'), opts.jsonc ?? false);
      return { value, status: 'restored-from-backup', corruptPath };
    } catch {
      return { value: undefined, status: 'corrupt', corruptPath };
    }
  }
}

export async function readJsonFile(path: string, opts: { jsonc?: boolean } = {}): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { value: undefined, status: 'missing' };
    throw e;
  }
  try {
    return { value: parseJsonText(text, opts.jsonc ?? false), status: 'ok' };
  } catch {
    const corruptPath = corruptName(path);
    await rename(path, corruptPath).catch(() => undefined);
    try {
      const value = parseJsonText(await readFile(`${path}.bak`, 'utf8'), opts.jsonc ?? false);
      return { value, status: 'restored-from-backup', corruptPath };
    } catch {
      return { value: undefined, status: 'corrupt', corruptPath };
    }
  }
}

export interface JsonFileStoreOptions<T> {
  path: string;
  schema: z.ZodType<T>;
  defaults: () => T;
  /** Migrates older file versions to the current shape (runs before validation). */
  migrate?: (raw: unknown) => unknown;
  debounceMs?: number;
  backup?: boolean;
  logger?: Logger;
}

/**
 * A validated JSON file with debounced, serialized, atomic writes and a `.bak` copy.
 * Invalid or corrupt content falls back to defaults (and the problem is reported via `loadStatus`).
 */
export class JsonFileStore<T> {
  private value: T;
  private _loadStatus: ReadStatus | 'invalid' = 'missing';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly o: JsonFileStoreOptions<T>) {
    this.value = o.defaults();
  }

  get loadStatus(): ReadStatus | 'invalid' {
    return this._loadStatus;
  }

  get(): T {
    return this.value;
  }

  private accept(result: ReadResult): T {
    this._loadStatus = result.status;
    if (result.value === undefined) {
      this.value = this.o.defaults();
      return this.value;
    }
    try {
      const migrated = this.o.migrate ? this.o.migrate(result.value) : result.value;
      this.value = this.o.schema.parse(migrated);
    } catch (e) {
      this.o.logger?.warn(`Invalid content in ${this.o.path}; using defaults`, e);
      this._loadStatus = 'invalid';
      this.value = this.o.defaults();
    }
    return this.value;
  }

  loadSync(): T {
    return this.accept(readJsonFileSync(this.o.path));
  }

  async load(): Promise<T> {
    return this.accept(await readJsonFile(this.o.path));
  }

  /** Replaces the value and schedules a debounced write. */
  set(value: T): void {
    this.value = value;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.o.debounceMs ?? 500);
  }

  update(fn: (current: T) => T): T {
    this.set(fn(this.value));
    return this.value;
  }

  /** Writes pending changes now (serialized with in-flight writes). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const content = `${JSON.stringify(this.value, null, 2)}\n`;
      try {
        await writeFileAtomic(this.o.path, content);
        if (this.o.backup) await copyFile(this.o.path, `${this.o.path}.bak`).catch(() => undefined);
      } catch (e) {
        this.dirty = true;
        this.o.logger?.error(`Failed to write ${this.o.path}`, e);
      }
    });
    return this.writing;
  }
}
