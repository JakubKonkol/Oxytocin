import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentAccount } from '@shared/domain/ai-agents';
import { OxyError } from '@shared/errors';
import { ACCOUNT_ADAPTERS, type AccountContext, claudeKeychainService, pathFor, type SharedItem } from './adapters';

export type EntryKind = 'missing' | 'file' | 'dir' | 'link';

/** The file system as the provisioning needs it (injectable: Windows' refusals are unit-tested on any system). */
export interface ProvisionFs {
  /** What is at the path, without following a link (a junction is a link). */
  kind(path: string): Promise<EntryKind>;
  readlink(path: string): Promise<string | null>;
  /** Creates the folder and its parents. */
  mkdir(path: string, mode?: number): Promise<void>;
  symlink(target: string, path: string, type: 'dir' | 'file' | 'junction'): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /** Removes a link itself (never what it points to). */
  unlink(path: string): Promise<void>;
  /** Removes a folder and everything in it; links inside are removed, not followed. */
  removeTree(path: string): Promise<void>;
}

export interface ProvisionDeps extends AccountContext {
  fs: ProvisionFs;
  /** `~/.oxytocin/accounts`: nothing outside it is ever created as an account or removed. */
  accountsRoot: string;
  /** macOS: removes a Keychain entry (an account's Claude Code sign-in). */
  deleteKeychainEntry?: (service: string) => Promise<void>;
}

/** `.oxytocin-account.json` in an account folder: written once the folder is set up. */
const MarkerSchema = z.looseObject({
  id: z.string(),
  agent: z.string(),
  createdAt: z.number(),
  /** Files shared as copies (Windows without file links): the SHA-256 of the content last copied. */
  copies: z.record(z.string(), z.string()).default({}),
});
type Marker = z.infer<typeof MarkerSchema>;

export const MARKER_FILE = '.oxytocin-account.json';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Throws unless `path` is an account folder inside the accounts root (`<root>/<agent>/<slug>`). */
export function assertAccountFolder(deps: Pick<ProvisionDeps, 'platform' | 'accountsRoot'>, path: string): void {
  const p = pathFor(deps.platform);
  const rel = p.relative(p.resolve(deps.accountsRoot), p.resolve(path));
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!rel || rel.startsWith('..') || p.isAbsolute(rel) || parts.length !== 2 || parts.includes('..'))
    throw new OxyError('PERMISSION', `Not an account folder of Oxytocin: ${path}`);
}

/** The same path, as links on this system report it (Windows: `\\?\` prefixes, any case, either slash). */
function samePath(platform: NodeJS.Platform, a: string, b: string): boolean {
  const p = pathFor(platform);
  const norm = (x: string) => {
    let v = p.resolve(x.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, ''));
    if (platform === 'win32') v = v.toLowerCase();
    return v.replace(/[\\/]+$/, '');
  };
  return norm(a) === norm(b);
}

/** `@~/.claude/CLAUDE.md` (or the absolute path when the main folder is not inside the home folder). */
function importLine(deps: AccountContext, target: string): string {
  const p = pathFor(deps.platform);
  const rel = p.relative(deps.home, target);
  const inside = rel && !rel.startsWith('..') && !p.isAbsolute(rel);
  return `@${inside ? `~/${rel.split(p.sep).join('/')}` : target.split(p.sep).join('/')}`;
}

async function readMarker(deps: ProvisionDeps, home: string): Promise<Marker | null> {
  const text = await deps.fs.readText(pathFor(deps.platform).join(home, MARKER_FILE));
  if (text === null) return null;
  try {
    const parsed = MarkerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function shareItem(
  deps: ProvisionDeps,
  item: SharedItem,
  mainRoot: string,
  root: string,
  marker: Marker,
): Promise<string | undefined> {
  const p = pathFor(deps.platform);
  const { fs } = deps;
  const target = p.join(mainRoot, ...item.name.split('/'));
  const link = p.join(root, ...item.name.split('/'));
  const kind = await fs.kind(link);

  if (item.kind === 'import') {
    if (kind !== 'missing') return undefined;
    await fs.writeText(
      link,
      `<!-- Managed by Oxytocin: this account uses the main account's global instructions. Add instructions for this account below. -->\n${importLine(deps, target)}\n`,
    );
    return undefined;
  }

  if (kind === 'link') {
    const points = await fs.readlink(link);
    if (points !== null && samePath(deps.platform, p.resolve(p.dirname(link), points), target)) return undefined;
    return `${item.name} links to another place than the main account's ${item.name}.`;
  }

  if (kind !== 'missing') {
    const copied = marker.copies[item.name];
    if (item.kind !== 'file' || kind !== 'file' || copied === undefined)
      return `${item.name} is the account's own: it is not shared with the main account.`;
    // A copy instead of a link (Windows without Developer Mode): follows the main file while left unchanged.
    const [mine, main] = await Promise.all([fs.readText(link), fs.readText(target)]);
    if (mine === null || main === null) return undefined;
    const [mineHash, mainHash] = [sha256(mine), sha256(main)];
    if (mineHash !== copied) {
      if (mineHash !== mainHash)
        return `${item.name} was changed in this account, so it no longer follows the main account's file.`;
      marker.copies[item.name] = mainHash;
    } else if (mainHash !== copied) {
      await fs.writeText(link, main);
      marker.copies[item.name] = mainHash;
    }
    return undefined;
  }

  await fs.mkdir(p.dirname(link));
  const targetKind = await fs.kind(target);
  if (item.kind === 'dir') {
    if (targetKind === 'missing') {
      // The main account is not set up yet (no ~/.claude): tried again at the next start.
      if ((await fs.kind(mainRoot)) === 'missing') return undefined;
      await fs.mkdir(target);
    }
    try {
      await fs.symlink(target, link, deps.platform === 'win32' ? 'junction' : 'dir');
      return undefined;
    } catch (e) {
      return `${item.name} could not be shared: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // A file: linked even before the main file exists (written through the link, it becomes the main file). Windows
  // refuses file links without Developer Mode: then a copy, once the main file exists (tried again at each start).
  try {
    await fs.symlink(target, link, 'file');
    return undefined;
  } catch (e) {
    if (deps.platform !== 'win32')
      return `${item.name} could not be shared: ${e instanceof Error ? e.message : String(e)}`;
    const main = await fs.readText(target);
    if (main === null) return undefined;
    await fs.writeText(link, main);
    marker.copies[item.name] = sha256(main);
    return undefined;
  }
}

/**
 * Sets up an account folder, or repairs it (run before every start: idempotent). In the shared setup it links the
 * main account's instructions, agents, skills, settings and plugins; anything the account already has is left as it
 * is and reported. Returns notes about what is not shared.
 */
export async function ensureAccount(account: AgentAccount, deps: ProvisionDeps): Promise<string[]> {
  assertAccountFolder(deps, account.home);
  const p = pathFor(deps.platform);
  const adapter = ACCOUNT_ADAPTERS[account.agent];
  const root = adapter.configRoot(account.home, deps);
  const mainRoot = adapter.configRoot(adapter.mainHome(deps), deps);
  await deps.fs.mkdir(account.home, 0o700);
  await deps.fs.mkdir(root, 0o700);
  const existing = await readMarker(deps, account.home);
  const marker: Marker = existing ?? { id: account.id, agent: account.agent, createdAt: account.createdAt, copies: {} };
  const before = JSON.stringify(marker.copies);
  const notes: string[] = [];
  if (account.mode === 'shared') {
    if (samePath(deps.platform, mainRoot, root)) throw new OxyError('INVALID', 'The account folder is the main one.');
    for (const item of adapter.shared) {
      const note = await shareItem(deps, item, mainRoot, root, marker);
      if (note) notes.push(note);
    }
    if (!existing) {
      for (const seed of adapter.seed) {
        const to = p.join(root, ...seed.name.split('/'));
        if ((await deps.fs.kind(to)) !== 'missing') continue;
        const main = await deps.fs.readText(seed.from(mainRoot, deps));
        const content = main === null ? undefined : seed.transform(main);
        if (content === undefined) continue;
        await deps.fs.mkdir(p.dirname(to));
        await deps.fs.writeText(to, content);
      }
    }
  }
  if (!existing || JSON.stringify(marker.copies) !== before)
    await deps.fs.writeText(p.join(account.home, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
  return notes;
}

/**
 * Deletes an account folder (only inside the accounts root): its sign-in, sessions and history. Links to the main
 * account are removed first, so nothing of the main account is touched. On macOS the Claude Code sign-in in the
 * Keychain is removed too.
 */
export async function removeAccountFolder(account: AgentAccount, deps: ProvisionDeps): Promise<void> {
  assertAccountFolder(deps, account.home);
  const p = pathFor(deps.platform);
  const adapter = ACCOUNT_ADAPTERS[account.agent];
  const root = adapter.configRoot(account.home, deps);
  for (const item of adapter.shared) {
    const link = p.join(root, ...item.name.split('/'));
    if ((await deps.fs.kind(link)) === 'link') await deps.fs.unlink(link);
  }
  await deps.fs.removeTree(account.home);
  if (account.agent === 'claude' && deps.platform === 'darwin')
    await deps.deleteKeychainEntry?.(claudeKeychainService(account.home)).catch(() => undefined);
}
