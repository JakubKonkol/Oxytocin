import { CODE_MAP_MCP_INSTRUCTIONS } from './code-map';

const START = '<!-- oxytocin:code-map:start -->';
const END = '<!-- oxytocin:code-map:end -->';
type Original = 'missing' | 'newline' | 'no-newline';
const LEGACY_INSTRUCTIONS =
  'When Code Map is available, read `.oxy/code-map/MAP.md` first, then use oxy_find_code with your working directory to locate relevant code. Use oxy_file_outline and oxy_code_relations for structure and likely dependencies. Check freshness, coverage, and resolution evidence; read current source before editing. Missing edges do not prove that code is unused. Fall back to normal search when results are incomplete or unavailable.';
function block(original: Original, eol: string, instructions = CODE_MAP_MCP_INSTRUCTIONS): string {
  return [START, `<!-- oxytocin:code-map:original=${original} -->`, instructions, END, ''].join(eol);
}

/** Changes only an exact generated block; its small marker records how to restore the original EOF. */
export function codeMapInstructionBlock(content: string | null, action: 'add' | 'remove'): string | null {
  const text = content ?? '',
    start = text.indexOf(START),
    end = text.indexOf(END);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (start < 0 && end < 0) {
    if (action === 'remove') return content;
    const original = content === null ? 'missing' : text && !text.endsWith('\n') ? 'no-newline' : 'newline';
    return text + (original === 'no-newline' ? eol : '') + block(original, eol);
  }
  if (
    start < 0 ||
    end < start ||
    text.indexOf(START, start + START.length) >= 0 ||
    text.indexOf(END, end + END.length) >= 0
  )
    throw new Error('The Code Map instruction markers are incomplete or duplicated; review the file manually.');
  const known = [CODE_MAP_MCP_INSTRUCTIONS, LEGACY_INSTRUCTIONS]
    .flatMap((instructions) =>
      (['missing', 'newline', 'no-newline'] as const).map((original) => ({ original, instructions })),
    )
    .find(({ original, instructions }) => text.slice(start).startsWith(block(original, eol, instructions)));
  if (!known) throw new Error('The Code Map instruction block was edited; review it manually before changing it.');
  const { original, instructions } = known;
  if (action === 'add')
    return text.slice(0, start) + block(original, eol) + text.slice(start + block(original, eol, instructions).length);
  const prefixEnd = original === 'no-newline' && text.slice(0, start).endsWith(eol) ? start - eol.length : start;
  const remaining = text.slice(0, prefixEnd) + text.slice(start + block(original, eol, instructions).length);
  return original === 'missing' && remaining === '' ? null : remaining;
}
