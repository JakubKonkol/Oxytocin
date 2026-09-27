import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { OXYTOCIN_API_VERSION } from '@shared/constants';
import type { PluginManifest } from '@shared/domain/plugin';
import { OxyError } from '@shared/errors';
import type { Logger } from '@shared/logging/logger';
import { isEngineCompatible, readPlugin } from './discovery';
import { nodeDiscoveryFs } from './plugin-service';

/** Limits for installed plugins (docs/plan/07-plugin-engine.md §5). */
export const INSTALL_LIMITS = { maxFiles: 10_000, maxBytes: 200 * 1024 * 1024 };

export interface InstalledPlugin {
  id: string;
  displayName: string;
  version: string;
  /** A previous installation with the same id was replaced. */
  replaced: boolean;
  /** Permissions or the Node backend differ from the replaced version: consent is needed again. */
  needsNewConsent: boolean;
}

const tooLarge = () =>
  new OxyError(
    'INVALID',
    `The plugin is too large (more than ${INSTALL_LIMITS.maxFiles} files or ${INSTALL_LIMITS.maxBytes / 1024 / 1024} MB).`,
  );

/** Extracts a zip archive into `dest` (an empty folder). Rejects unsafe paths, symlinks and oversized content. */
export async function extractZip(zipPath: string, dest: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (e, z) =>
      e ? fail(new OxyError('INVALID', `Not a valid .zip file: ${e.message}`)) : ok(z),
    ),
  );
  const root = resolve(dest);
  let files = 0;
  let bytes = 0;
  try {
    await new Promise<void>((ok, fail) => {
      const next = () => zip.readEntry();
      zip.on('error', (e: Error) => fail(new OxyError('INVALID', `Not a valid .zip file: ${e.message}`)));
      zip.on('end', () => ok());
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName;
          const target = resolve(root, name);
          if (target !== root && !target.startsWith(root + sep)) throw new OxyError('INVALID', `Unsafe path: ${name}`);
          // Unix mode in the upper 16 bits: symbolic links are skipped (they could point outside the plugin).
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) return next();
          if (name.endsWith('/')) {
            await mkdir(target, { recursive: true });
            return next();
          }
          files++;
          bytes += entry.uncompressedSize;
          if (files > INSTALL_LIMITS.maxFiles || bytes > INSTALL_LIMITS.maxBytes) throw tooLarge();
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((ok2, fail2) =>
            zip.openReadStream(entry, (e, s) => (e ? fail2(e) : ok2(s))),
          );
          await pipeline(stream, createWriteStream(target));
          next();
        })().catch(fail);
      });
      next();
    });
  } finally {
    zip.close();
  }
}

/** Counts files and bytes of a folder (without following symlinks), stopping at the limits. */
async function checkFolderSize(dir: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files++;
        bytes += (await lstat(path)).size;
        if (files > INSTALL_LIMITS.maxFiles || bytes > INSTALL_LIMITS.maxBytes) throw tooLarge();
      }
    }
  };
  await walk(dir);
}

/** The plugin root inside an extracted archive: the top level, or its only folder (`my-plugin/package.json`). */
async function findRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) return dir;
  const folders = entries.filter((e) => e.isDirectory() && e.name !== '__MACOSX');
  if (folders.length === 1 && entries.filter((e) => e.isFile()).length === 0) return join(dir, folders[0]!.name);
  return dir;
}

const consentKey = (m: PluginManifest) => JSON.stringify([[...m.permissions].sort(), !!m.main]);

/**
 * Installs user plugins into `userData/plugins/<id>` from a folder or a .zip archive (docs/plan/07-plugin-engine.md
 * §5, M9-T3). The plugin is validated before anything in the plugins folder changes; a previous version is replaced
 * only after the new one is complete.
 */
export class PluginInstaller {
  constructor(
    private readonly userDir: string,
    private readonly logger: Logger,
    private readonly apiVersion: string = OXYTOCIN_API_VERSION,
  ) {}

  async install(source: string): Promise<InstalledPlugin> {
    const info = await stat(source).catch(() => null);
    if (!info) throw new OxyError('NOT_FOUND', `${source} does not exist`);
    if (!info.isDirectory() && !source.toLowerCase().endsWith('.zip'))
      throw new OxyError('INVALID', 'Choose a plugin folder or a .zip file.');
    await mkdir(this.userDir, { recursive: true });
    const staging = join(this.userDir, `.staging-${randomBytes(6).toString('hex')}`);
    try {
      if (info.isDirectory()) {
        await checkFolderSize(source);
        await cp(source, staging, {
          recursive: true,
          verbatimSymlinks: true,
          filter: (src) => !relative(source, src).split(/[\\/]/).includes('.git'),
        });
      } else {
        await mkdir(staging);
        await extractZip(source, staging);
      }
      const root = await findRoot(staging);
      const candidate = await readPlugin(root, 'user', nodeDiscoveryFs);
      if (!candidate)
        throw new OxyError('INVALID', 'No Oxytocin plugin found (a package.json with an "oxytocin" section).');
      const manifest = candidate.manifest;
      if (!manifest || candidate.errors.length > 0)
        throw new OxyError('INVALID', `The plugin is invalid: ${candidate.errors.slice(0, 3).join('; ')}`);
      if (!isEngineCompatible(manifest.engine, this.apiVersion))
        throw new OxyError(
          'INVALID',
          `${manifest.displayName} requires Oxytocin API ${manifest.engine} (this version provides ${this.apiVersion}).`,
        );

      const dest = join(this.userDir, manifest.id);
      const previous = await readPlugin(dest, 'user', nodeDiscoveryFs).catch(() => null);
      const replaced = (await stat(dest).catch(() => null)) !== null;
      let old: string | null = null;
      if (replaced) {
        old = join(this.userDir, `.old-${randomBytes(6).toString('hex')}`);
        await rename(dest, old);
      }
      try {
        await rename(root, dest);
      } catch (e) {
        if (old) await rename(old, dest).catch(() => undefined);
        throw e;
      }
      if (old) await rm(old, { recursive: true, force: true }).catch(() => undefined);
      this.logger.info(`Installed plugin ${manifest.id}@${candidate.version} from ${source}`);
      return {
        id: manifest.id,
        displayName: manifest.displayName,
        version: candidate.version,
        replaced,
        needsNewConsent: !previous?.manifest || consentKey(previous.manifest) !== consentKey(manifest),
      };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Removes an installed plugin folder (only inside the user plugins folder). */
  async uninstall(id: string, path: string): Promise<void> {
    const dir = resolve(path);
    if (dirname(dir) !== resolve(this.userDir)) throw new OxyError('PERMISSION', `${id} is not an installed plugin`);
    await rm(dir, { recursive: true, force: true });
    this.logger.info(`Uninstalled plugin ${id}`);
  }

  /** Leftovers of an interrupted installation. */
  async cleanup(): Promise<void> {
    const names = await readdir(this.userDir).catch(() => [] as string[]);
    for (const name of names)
      if (name.startsWith('.staging-') || name.startsWith('.old-'))
        await rm(join(this.userDir, name), { recursive: true, force: true }).catch(() => undefined);
  }
}
