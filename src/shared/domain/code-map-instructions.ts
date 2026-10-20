import { CODE_MAP_MCP_INSTRUCTIONS } from './code-map';

const START = '<!-- oxytocin:code-map:start -->';
const END = '<!-- oxytocin:code-map:end -->';
type Original = 'missing' | 'newline' | 'no-newline';
function block(original: Original, eol: string): string {
  return [START, `<!-- oxytocin:code-map:original=${original} -->`, CODE_MAP_MCP_INSTRUCTIONS, END, ''].join(eol);
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
  const original = (['missing', 'newline', 'no-newline'] as const).find((value) =>
    text.slice(start).startsWith(block(value, eol)),
  );
  if (!original) throw new Error('The Code Map instruction block was edited; review it manually before changing it.');
  if (action === 'add') return content;
  const prefixEnd = original === 'no-newline' && text.slice(0, start).endsWith(eol) ? start - eol.length : start;
  const remaining = text.slice(0, prefixEnd) + text.slice(start + block(original, eol).length);
  return original === 'missing' && remaining === '' ? null : remaining;
}
