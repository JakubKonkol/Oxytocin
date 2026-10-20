import { expect, it } from 'vitest';
import { codeMapInstructionBlock } from './code-map-instructions';

it('updates or removes an exact historical generated block without changing surrounding rules', () => {
  const legacy =
    'When Code Map is available, read `.oxy/code-map/MAP.md` first, then use oxy_find_code with your working directory to locate relevant code. Use oxy_file_outline and oxy_code_relations for structure and likely dependencies. Check freshness, coverage, and resolution evidence; read current source before editing. Missing edges do not prove that code is unused. Fall back to normal search when results are incomplete or unavailable.';
  const original = '\ufeff# Rules\r\n';
  const old = `${original}<!-- oxytocin:code-map:start -->\r\n<!-- oxytocin:code-map:original=newline -->\r\n${legacy}\r\n<!-- oxytocin:code-map:end -->\r\n`;
  expect(codeMapInstructionBlock(old, 'remove')).toBe(original);
  expect(codeMapInstructionBlock(old, 'add')).toContain('Propose only reusable');
  expect(codeMapInstructionBlock(codeMapInstructionBlock(old, 'add'), 'remove')).toBe(original);
});

it('adds exactly one block and restores original files byte for byte, including BOM, CRLF and missing files', () => {
  for (const original of [null, '', '# Rules', '# Rules\n', '\ufeff# Rules\r\n\r\n']) {
    const added = codeMapInstructionBlock(original, 'add');
    expect(added).toContain('oxy_find_code');
    expect(codeMapInstructionBlock(added, 'add')).toBe(added);
    expect(codeMapInstructionBlock(added, 'remove')).toBe(original);
    expect(codeMapInstructionBlock(original, 'remove')).toBe(original);
    if (original?.includes('\r\n')) expect(added!.replaceAll('\r\n', '')).not.toContain('\n');
  }
});
it('preserves text added after the block and refuses edited, incomplete or duplicate blocks', () => {
  const added = codeMapInstructionBlock('Original', 'add')!;
  expect(codeMapInstructionBlock(`${added}Later\n`, 'remove')).toBe('OriginalLater\n');
  expect(() => codeMapInstructionBlock(added.replace('oxy_find_code', 'edited_tool'), 'remove')).toThrow('edited');
  expect(() => codeMapInstructionBlock(added + added, 'add')).toThrow('duplicated');
  expect(() => codeMapInstructionBlock('<!-- oxytocin:code-map:start -->', 'remove')).toThrow('incomplete');
});
