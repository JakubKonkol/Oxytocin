let cached: Record<string, string> | null = null;

/** Design tokens (custom properties declared on :root) with their computed values, for plugin views. */
export function themeTokens(): Record<string, string> {
  if (cached) return cached;
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || !rule.selectorText.split(',').some((s) => s.trim() === ':root')) continue;
      for (const name of Array.from(rule.style)) if (name.startsWith('--')) names.add(name);
    }
  }
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  if (Object.keys(tokens).length > 0) cached = tokens;
  return tokens;
}
