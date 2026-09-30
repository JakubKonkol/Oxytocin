/** Parses a `.env` file: `KEY=value`, `export KEY=value`, quoted values (double quotes: `\n` escapes, several lines). */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const key = m[1]!;
    let i = re.lastIndex;
    let value = '';
    const q = src[i];
    if (q === '"' || q === "'" || q === '`') {
      i++;
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === '\\' && i + 1 < src.length) {
          const e = src[i + 1]!;
          value += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e;
          i += 2;
        } else value += src[i++];
      }
      const eol = src.indexOf('\n', i);
      re.lastIndex = eol < 0 ? src.length : eol + 1;
    } else {
      const eol = src.indexOf('\n', i);
      const line = src.slice(i, eol < 0 ? src.length : eol);
      value = line.replace(/\s+#.*$/, '').trim();
      re.lastIndex = eol < 0 ? src.length : eol + 1;
    }
    out.set(key, value);
  }
  return out;
}
