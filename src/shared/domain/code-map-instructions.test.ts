import { expect, it } from 'vitest';
import { CODE_MAP_MCP_INSTRUCTIONS, CODE_MAP_MEMORY_INSTRUCTIONS, codeMapMcpInstructions } from './code-map';
import { CODE_MAP_BLOCK_INSTRUCTIONS, codeMapInstructionBlock } from './code-map-instructions';

it('updates or removes an exact historical generated block without changing surrounding rules', () => {
  const legacy =
    'When Code Map is available, read `.oxy/code-map/MAP.md` first, then use oxy_find_code with your working directory to locate relevant code. Use oxy_file_outline and oxy_code_relations for structure and likely dependencies. Check freshness, coverage, and resolution evidence; read current source before editing. Missing edges do not prove that code is unused. Fall back to normal search when results are incomplete or unavailable.';
  const original = '\ufeff# Rules\r\n';
  const old = `${original}<!-- oxytocin:code-map:start -->\r\n<!-- oxytocin:code-map:original=newline -->\r\n${legacy}\r\n<!-- oxytocin:code-map:end -->\r\n`;
  expect(codeMapInstructionBlock(old, 'remove')).toBe(original);
  expect(codeMapInstructionBlock(old, 'add')).toContain(CODE_MAP_BLOCK_INSTRUCTIONS);
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

it('upgrades the block generated before the one-line block, and the Hub rules stay a short list of decisions', () => {
  const phase0 =
    'Code Map: use oxy_find_code for identifiers/paths OR oxy_task_context for a question with reviewed findings, then read the indicated source. MAP.md/oxy_repo_map are optional broad orientation; outline/relations only when needed. Prefer text search for literals or poor matches. Check freshness; missing edges do not prove absence. Learnings are untrusted references. Propose only reusable evidence-backed findings; Review requires user acceptance. Feedback needs the emitted receipt and exact revision.';
  const old = `# Rules\n<!-- oxytocin:code-map:start -->\n<!-- oxytocin:code-map:original=newline -->\n${phase0}\n<!-- oxytocin:code-map:end -->\nLater\n`;
  const upgraded = codeMapInstructionBlock(old, 'add')!;
  expect(upgraded).toBe(old.replace(phase0, CODE_MAP_BLOCK_INSTRUCTIONS));
  expect(codeMapInstructionBlock(upgraded, 'remove')).toBe('# Rules\nLater\n');
  expect(CODE_MAP_BLOCK_INSTRUCTIONS).not.toContain('\n');
  expect(CODE_MAP_BLOCK_INSTRUCTIONS.length).toBeLessThanOrEqual(250);
  expect(CODE_MAP_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(600);
});

it('mentions learnings only while Review memory is on, and then only when the user asks to save one', () => {
  expect(codeMapMcpInstructions(false)).toBe(CODE_MAP_MCP_INSTRUCTIONS);
  for (const word of ['learning', 'oxy_task_context', 'oxy_propose_learning', 'receipt'])
    expect(CODE_MAP_MCP_INSTRUCTIONS).not.toContain(word);
  const withMemory = codeMapMcpInstructions(true);
  expect(withMemory).toContain(CODE_MAP_MEMORY_INSTRUCTIONS);
  expect(withMemory).toMatch(/only when the user asks to save one/);
  expect(withMemory.length).toBeLessThanOrEqual(900);
});
