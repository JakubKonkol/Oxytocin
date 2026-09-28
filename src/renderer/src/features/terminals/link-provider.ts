import type { IDisposable, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { ipc } from '../../lib/ipc-client';
import { currentPlatform } from '../../lib/platform';
import { findFileLinks } from './file-links';

const CACHE_MS = 5000;
const MAX_CANDIDATES = 50;

interface CacheEntry {
  at: number;
  resolved: string | null;
}

export interface FileLinkTarget {
  path: string;
  line?: number;
  column?: number;
}

/**
 * Terminal file links: candidates found in a line are verified in batch through `fs:statMany`
 * (relative to the terminal cwd, then the project root) and activated with Ctrl/⌘+click (Shift+Ctrl/⌘+click is
 * passed on through the event).
 */
export function registerFileLinkProvider(
  term: Terminal,
  getBaseDirs: () => string[],
  onActivate: (target: FileLinkTarget, event: MouseEvent) => void,
): IDisposable {
  const cache = new Map<string, CacheEntry>();
  const modifier = currentPlatform() === 'darwin' ? 'metaKey' : 'ctrlKey';
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const matches = findFileLinks(line).slice(0, MAX_CANDIDATES);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const baseDirs = getBaseDirs();
      const key = (p: string) => `${baseDirs.join('|')}::${p}`;
      const now = Date.now();
      const unknown = [...new Set(matches.map((m) => m.path))].filter((p) => {
        const hit = cache.get(key(p));
        return !hit || now - hit.at > CACHE_MS;
      });
      const lookup = unknown.length
        ? ipc.invoke('fs:statMany', { baseDirs, paths: unknown }).then((results) => {
            for (const r of results) cache.set(key(r.path), { at: Date.now(), resolved: r.isFile ? r.resolved : null });
          })
        : Promise.resolve();
      lookup
        .then(() => {
          const links: ILink[] = [];
          for (const m of matches) {
            const resolved = cache.get(key(m.path))?.resolved;
            if (!resolved) continue;
            links.push({
              text: line.slice(m.start, m.start + m.length),
              range: { start: { x: m.start + 1, y }, end: { x: m.start + m.length, y } },
              decorations: { underline: true, pointerCursor: true },
              activate: (event) => {
                if (!event[modifier]) return;
                onActivate(
                  {
                    path: resolved,
                    ...(m.line ? { line: m.line } : {}),
                    ...(m.column ? { column: m.column } : {}),
                  },
                  event,
                );
              },
            });
          }
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  };
  return term.registerLinkProvider(provider);
}
