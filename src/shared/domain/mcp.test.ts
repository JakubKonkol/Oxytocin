import { describe, expect, it } from 'vitest';
import { defaultPolicy, McpContributionSchema, normalizeToolResult } from './mcp';
import { PluginManifestSchema } from './plugin';

const tool = (name: string) => ({ name, description: 'x', inputSchema: { type: 'object' } });

describe('contributes.mcp', () => {
  it('accepts a prefix and tools named after it', () => {
    const parsed = McpContributionSchema.parse({ prefix: 'tests', tools: [tool('tests_run')] });
    expect(parsed.tools[0]!.name).toBe('tests_run');
  });

  it('rejects the reserved prefix, foreign names, duplicates and non-object schemas', () => {
    expect(McpContributionSchema.safeParse({ prefix: 'oxy', tools: [] }).success).toBe(false);
    expect(McpContributionSchema.safeParse({ prefix: 'Tests', tools: [] }).success).toBe(false);
    expect(McpContributionSchema.safeParse({ prefix: 'tests', tools: [tool('other_run')] }).success).toBe(false);
    expect(
      McpContributionSchema.safeParse({ prefix: 'tests', tools: [tool('tests_a'), tool('tests_a')] }).success,
    ).toBe(false);
    expect(
      McpContributionSchema.safeParse({
        prefix: 'tests',
        tools: [{ ...tool('tests_a'), inputSchema: { type: 'string' } }],
      }).success,
    ).toBe(false);
    expect(
      McpContributionSchema.safeParse({ prefix: 'tests', tools: [{ ...tool('tests_a'), timeoutMs: 900_000 }] }).success,
    ).toBe(false);
  });

  it('needs the mcp.tools permission and accepts onMcpTool activation', () => {
    const manifest = {
      id: 'acme.tests',
      displayName: 'Tests',
      publisher: 'acme',
      engine: '^0.1.5',
      activationEvents: ['onMcpTool:tests_run'],
      contributes: { mcp: { prefix: 'tests', tools: [tool('tests_run')] } },
    };
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest, permissions: ['mcp.tools'] }).success).toBe(true);
  });

  it('asks first for destructive tools by default', () => {
    expect(defaultPolicy({ destructiveHint: true })).toBe('ask');
    expect(defaultPolicy({ readOnlyHint: true })).toBe('allow');
    expect(defaultPolicy(undefined)).toBe('allow');
  });
});

describe('normalizeToolResult', () => {
  it('wraps strings and validates results', () => {
    expect(normalizeToolResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(normalizeToolResult(undefined)).toEqual({ content: [] });
    expect(normalizeToolResult({ content: 'nope' })).toMatchObject({ isError: true });
  });

  it('cuts long text and drops large images with a note', () => {
    const r = normalizeToolResult(
      {
        content: [
          { type: 'text', text: 'é'.repeat(20) },
          { type: 'text', text: 'more' },
          { type: 'image', data: 'A'.repeat(40), mimeType: 'image/png' },
        ],
      },
      { text: 21, image: 10 },
    );
    const [first, second, image] = r.content as { type: 'text'; text: string }[];
    expect(first!.text.startsWith('é'.repeat(10))).toBe(true);
    expect(first!.text).toContain('[Output truncated');
    expect(second!.text).toContain('[Output truncated');
    expect(image!.text).toMatch(/image .* left out/);
  });
});
