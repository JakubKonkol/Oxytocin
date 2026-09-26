// Test plugin: exercises the backend API (tests/integration/plugin-runtime.test.ts, E2E).
let deactivated = 0;

export function activate(ctx) {
  const { oxy } = ctx;
  ctx.log.info('echo activated');
  ctx.subscriptions.push(
    oxy.commands.register('echo.hello', (...args) => ({
      echo: args,
      greeting: oxy.settings.get('echo.greeting') ?? 'Hello',
    })),
    oxy.commands.register('echo.projects', () => oxy.projects.list()),
    oxy.commands.register('echo.terminals', () => oxy.terminals.list()),
    // No git.read permission: must fail with PERMISSION.
    oxy.commands.register('echo.git', () => oxy.git.getStatus('x')),
    oxy.commands.register('echo.store', async (value) => {
      await ctx.storage.set('last', value);
      return ctx.storage.get('last');
    }),
    oxy.commands.register('test.echo.deactivations', () => deactivated),
  );
  const item = oxy.ui.statusBarItem('echo.status');
  item.text = '$(pulse) echo';
  item.tooltip = 'Echo test plugin';
  item.show();
  oxy.terminals.environment.replace('OXY_ECHO', 'from-echo');
  oxy.terminals.environment.ready();
}

export function deactivate() {
  deactivated++;
}
