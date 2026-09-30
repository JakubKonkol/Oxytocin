// Test plugin: MCP tools (tests/integration/mcp-hub.test.ts, plugin-runtime.test.ts, tests/e2e/mcp-hub.spec.ts).
let dynamic;

export function activate(ctx) {
  const { oxy } = ctx;
  ctx.subscriptions.push(
    oxy.mcp.registerTool('tests_echo', (args, context) => ({
      content: [{ type: 'text', text: `echo: ${String(args.text)}` }],
      structuredContent: { projectId: context.projectId ?? null, terminalId: context.terminalId ?? null },
    })),
    oxy.mcp.registerTool(
      'tests_wait',
      (_args, context) =>
        new Promise((resolve) => context.signal.addEventListener('abort', () => resolve('aborted'), { once: true })),
    ),
    oxy.mcp.registerTool('tests_reset', () => 'reset done'),
    oxy.commands.register('tests.addDynamic', () => {
      dynamic ??= oxy.mcp.registerTool(
        {
          name: 'tests_dynamic',
          title: 'Dynamic',
          description: 'A tool registered at runtime.',
          inputSchema: { type: 'object' },
        },
        () => 'dynamic works',
      );
      return true;
    }),
    oxy.commands.register('tests.removeDynamic', () => {
      dynamic?.dispose();
      dynamic = undefined;
      return true;
    }),
  );
}

export function deactivate() {
  dynamic = undefined;
}
