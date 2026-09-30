const escape = (c: string) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** A name glob (`*` any characters, `?` one), matched case-insensitively against the whole name. */
export function nameGlob(glob: string): RegExp {
  let out = '';
  for (const c of glob) out += c === '*' ? '.*' : c === '?' ? '.' : escape(c);
  return new RegExp(`^${out}$`, 'i');
}

/** True when a column or field name matches one of the masking globs. */
export function matchesAny(name: string, globs: readonly string[]): boolean {
  return globs.some((g) => nameGlob(g).test(name));
}

/**
 * A URL path glob: `*` matches within one segment, `**` any number of segments (`/api/**` matches `/api` and
 * everything below it). Case-sensitive, like URL paths.
 */
export function pathGlob(glob: string): RegExp {
  const g = glob.startsWith('/') ? glob : `/${glob}`;
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      i++;
      // `/**` also matches the parent itself.
      if (out.endsWith('/') && (g[i + 1] === undefined || g[i + 1] === '/')) {
        out = `${out.slice(0, -1)}(?:/.*)?`;
        if (g[i + 1] === '/') i++;
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}
