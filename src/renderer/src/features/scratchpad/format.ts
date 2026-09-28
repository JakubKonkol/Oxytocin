/**
 * Markdown formatting of the scratchpad (pure functions over text + selection, so they are unit-tested).
 * A change replaces `text.slice(from, to)` with `insert` and then selects `selStart..selEnd`.
 */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'code';
export type LineFormat = 'heading' | 'bullet' | 'numbered' | 'task' | 'quote';

const MARKERS: Record<InlineFormat, string> = { bold: '**', italic: '_', strike: '~~', code: '`' };

/** Wraps the selection in a Markdown marker, or removes it when the selection is already wrapped. */
export function toggleInline(text: string, start: number, end: number, format: InlineFormat): TextChange {
  const m = MARKERS[format];
  const selected = text.slice(start, end);
  // Markers just outside the selection: **|word|**
  if (text.slice(start - m.length, start) === m && text.slice(end, end + m.length) === m) {
    return {
      from: start - m.length,
      to: end + m.length,
      insert: selected,
      selStart: start - m.length,
      selEnd: end - m.length,
    };
  }
  // Markers inside the selection: |**word**|
  if (selected.length >= 2 * m.length && selected.startsWith(m) && selected.endsWith(m)) {
    const inner = selected.slice(m.length, selected.length - m.length);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  return {
    from: start,
    to: end,
    insert: `${m}${selected}${m}`,
    selStart: start + m.length,
    selEnd: end + m.length,
  };
}

/** Puts the selected lines in a fenced code block (or an empty block at the caret). */
export function codeBlock(text: string, start: number, end: number): TextChange {
  const from = lineStart(text, start);
  const to = lineEnd(text, end > start && text[end - 1] === '\n' ? end - 1 : end);
  const body = text.slice(from, to);
  const insert = `\`\`\`\n${body}\n\`\`\``;
  const caret = from + 4;
  return { from, to, insert, selStart: caret, selEnd: caret + body.length };
}

const LIST_PREFIX = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> |#{1,6} )/;

const PREFIX_OF: Record<LineFormat, RegExp> = {
  heading: /^(\s*)#{1,6} /,
  bullet: /^(\s*)[-*+] (?!\[[ xX]\] )/,
  numbered: /^(\s*)\d+[.)] /,
  task: /^(\s*)[-*+] \[[ xX]\] /,
  quote: /^(\s*)> /,
};

function prefixFor(format: LineFormat, index: number): string {
  switch (format) {
    case 'heading':
      return '## ';
    case 'bullet':
      return '- ';
    case 'numbered':
      return `${index + 1}. `;
    case 'task':
      return '- [ ] ';
    case 'quote':
      return '> ';
  }
}

/**
 * Toggles a line prefix (heading, list, task, quote) on every selected line: removed when all lines have it,
 * otherwise added (replacing another list prefix).
 */
export function toggleLinePrefix(text: string, start: number, end: number, format: LineFormat): TextChange {
  const from = lineStart(text, start);
  const to = lineEnd(text, end > start && text[end - 1] === '\n' ? end - 1 : end);
  const lines = text.slice(from, to).split('\n');
  const pattern = PREFIX_OF[format];
  const all = lines.some((l) => l.trim() !== '') && lines.every((l) => pattern.test(l) || l.trim() === '');
  let counter = 0;
  const next = lines.map((line) => {
    if (all) return line.replace(pattern, '$1');
    if (line.trim() === '' && lines.length > 1) return line;
    const indent = /^\s*/.exec(line)![0];
    const rest = line.replace(LIST_PREFIX, '$1').slice(indent.length);
    return `${indent}${prefixFor(format, counter++)}${rest}`;
  });
  const insert = next.join('\n');
  if (lines.length === 1) {
    // Keep the caret on the same text.
    const delta = insert.length - (to - from);
    const caretStart = Math.max(from, start + delta);
    const caretEnd = Math.max(from, end + delta);
    return { from, to, insert, selStart: caretStart, selEnd: caretEnd };
  }
  return { from, to, insert, selStart: from, selEnd: from + insert.length };
}

/**
 * Enter at the end of a list item continues the list ("- ", "2. ", "- [ ] ", "> "); Enter on an empty item ends
 * it. Returns null when Enter should just insert a newline.
 */
export function continueList(text: string, caret: number): TextChange | null {
  const from = lineStart(text, caret);
  const line = text.slice(from, lineEnd(text, caret));
  const match = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
  if (!match) return null;
  const prefixEnd = from + match[0].length;
  if (caret < prefixEnd) return null;
  if (line.slice(match[0].length).trim() === '' && caret === from + line.length) {
    // An empty item: end the list (remove its marker).
    return {
      from,
      to: from + line.length,
      insert: match[1]!,
      selStart: from + match[1]!.length,
      selEnd: from + match[1]!.length,
    };
  }
  const indent = match[1]!;
  const marker = match[2]!;
  const nextMarker = match[3]
    ? `${Number(match[3]) + 1}${match[4]} `
    : /\[[ xX]\]/.test(marker)
      ? marker.replace(/\[[xX]\]/, '[ ]')
      : marker;
  const insert = `\n${indent}${nextMarker}`;
  return { from: caret, to: caret, insert, selStart: caret + insert.length, selEnd: caret + insert.length };
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const next = text.indexOf('\n', index);
  return next === -1 ? text.length : next;
}

/** Applies a change to a string (used when `execCommand` is unavailable and in tests). */
export function applyChange(text: string, change: TextChange): string {
  return text.slice(0, change.from) + change.insert + text.slice(change.to);
}
