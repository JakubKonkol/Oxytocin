/** Canonical model name as written in agent logs (lower case, provider prefixes and context suffixes removed). */
export function canonicalModel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(anthropic|openai|google|models)\//, '')
    .replace(/^(anthropic|openai|google|models)\//, '')
    .replace(/\[[^\]]*\]$/, '');
}

/**
 * Finds the pricing key for a model name (docs/plan/08-usage-monitor.md §10.3): exact → without a date suffix →
 * without `-latest`/`-preview` → the longest known model that is a prefix of the name. Undefined = unknown model.
 */
export function resolveModelKey(raw: string, known: (key: string) => boolean): string | undefined {
  const name = canonicalModel(raw);
  if (!name) return undefined;
  const candidates = [name];
  const noDate = name.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  candidates.push(noDate);
  candidates.push(noDate.replace(/-(latest|preview)$/, ''));
  for (const c of candidates) if (known(c)) return c;
  // Longest prefix of the family, e.g. "claude-opus-5-5-thinking" → "claude-opus-5-5".
  const parts = noDate.split('-');
  for (let n = parts.length - 1; n >= 2; n--) {
    const prefix = parts.slice(0, n).join('-');
    if (known(prefix)) return prefix;
  }
  return undefined;
}
