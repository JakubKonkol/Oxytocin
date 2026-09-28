import { createCssVariablesTheme, createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/shellscript.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import dockerfile from 'shiki/langs/dockerfile.mjs';
import go from 'shiki/langs/go.mjs';
import html from 'shiki/langs/html.mjs';
import ini from 'shiki/langs/ini.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsonc from 'shiki/langs/jsonc.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import powershell from 'shiki/langs/powershell.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import scss from 'shiki/langs/scss.mjs';
import sql from 'shiki/langs/sql.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

/** Colours come from CSS variables (`--shiki-*`) that the view maps to the shell's theme tokens. */
const THEME = createCssVariablesTheme({ name: 'oxytocin', variablePrefix: '--shiki-', fontStyle: true });
const LANGS = [
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  html,
  ini,
  java,
  javascript,
  json,
  jsonc,
  jsx,
  kotlin,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  xml,
  yaml,
];
const EXTRA_ALIASES: Record<string, string> = { console: 'shellscript', shell: 'shellscript', ps: 'powershell' };

let highlighter: HighlighterCore | undefined;

function get(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [THEME],
    langs: LANGS,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

/** Highlighted `<pre>` for a fenced code block, or undefined for unknown languages (plain block). */
export function highlightCode(code: string, lang: string): string | undefined {
  const name = lang.trim().toLowerCase();
  if (!name) return undefined;
  const h = get();
  const resolved = EXTRA_ALIASES[name] ?? name;
  if (!h.getLoadedLanguages().includes(resolved)) return undefined;
  try {
    return h.codeToHtml(code, { lang: resolved, theme: 'oxytocin' });
  } catch {
    return undefined;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A whole file highlighted line by line: the inner HTML of each line (coloured `<span>`s), or undefined for unknown
 * languages.
 */
export function highlightLines(code: string, lang: string): string[] | undefined {
  const h = get();
  const resolved = EXTRA_ALIASES[lang] ?? lang;
  if (!h.getLoadedLanguages().includes(resolved)) return undefined;
  try {
    const { tokens } = h.codeToTokens(code, { lang: resolved, theme: 'oxytocin' });
    return tokens.map((line) =>
      line
        .map((t) => {
          const styles = [
            t.color ? `color:${t.color}` : '',
            t.fontStyle && t.fontStyle & 1 ? 'font-style:italic' : '',
            t.fontStyle && t.fontStyle & 2 ? 'font-weight:bold' : '',
            t.fontStyle && t.fontStyle & 4 ? 'text-decoration:underline' : '',
          ].filter(Boolean);
          const text = escapeHtml(t.content);
          return styles.length ? `<span style="${styles.join(';')}">${text}</span>` : text;
        })
        .join(''),
    );
  } catch {
    return undefined;
  }
}
