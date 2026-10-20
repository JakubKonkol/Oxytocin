import { expect, it } from 'vitest';
import { codeMapInstructionBlock } from './code-map-instructions';

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
