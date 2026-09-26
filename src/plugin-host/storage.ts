import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginStorage } from '@oxytocin/plugin-api';

const MAX_BYTES = 1024 * 1024;

/** `userData/plugin-data/<pluginId>/` with a small JSON key/value store (docs/plan/07-plugin-engine.md §6.4). */
export function createPluginStorage(userDataDir: string, pluginId: string): PluginStorage {
  const globalDir = join(userDataDir, 'plugin-data', pluginId);
  const file = join(globalDir, 'storage.json');
  let data: Record<string, unknown> | undefined;
  let writing = Promise.resolve();
  const load = () => {
    if (data) return data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      data = {};
    }
    return data;
  };
  const persist = () => {
    const json = JSON.stringify(load());
    if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('Plugin storage is limited to 1 MB');
    writing = writing.then(async () => {
      await mkdir(globalDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, json);
      await rename(tmp, file);
    });
    return writing;
  };
  return {
    get globalDir() {
      mkdirSync(globalDir, { recursive: true });
      return globalDir;
    },
    projectDir(projectId: string) {
      if (!/^[\w.-]+$/.test(projectId)) throw new Error(`Invalid project id: ${projectId}`);
      const dir = join(globalDir, 'projects', projectId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    get<T>(key: string): T | undefined {
      return load()[key] as T | undefined;
    },
    async set(key, value) {
      const previous = load()[key];
      load()[key] = JSON.parse(JSON.stringify(value)) as unknown;
      try {
        await persist();
      } catch (e) {
        load()[key] = previous;
        throw e;
      }
    },
    async delete(key) {
      delete load()[key];
      await persist();
    },
  };
}
