import type { PluginContext } from '@oxytocin/plugin-api';

/** Answer of the panel's `greet` request (see src/views). */
export interface Greeting {
  text: string;
  projects: number;
}

/** Runs in Oxytocin's Plugin Host (Node.js) when the plugin is activated (`activationEvents` in package.json). */
export function activate(ctx: PluginContext): void {
  const { oxy } = ctx;

  const status = oxy.ui.statusBarItem('{{prefix}}.status');
  status.text = '$(pulse) {{name}}';
  status.tooltip = 'Open {{name}}';
  status.command = '{{prefix}}.open';
  status.show();

  ctx.subscriptions.push(
    status,
    oxy.commands.register('{{prefix}}.open', () => oxy.ui.openPanel('{{prefix}}.main')),
    oxy.commands.register('{{prefix}}.hello', async () => {
      const active = await oxy.projects.getActive();
      await oxy.ui.showNotification({
        level: 'info',
        message: `Hello from {{name}}${active ? ` in ${active.name}` : ''}!`,
      });
    }),
    // The panel declared in contributes.panels: answers requests from its view.
    oxy.ui.registerPanelProvider('{{prefix}}.main', {
      resolve(view) {
        view.title = '{{name}}';
        view.onRequest<{ name: string }, Greeting>('greet', async ({ name }) => ({
          text: `Hello, ${name}!`,
          projects: (await oxy.projects.list()).length,
        }));
      },
    }),
  );
  ctx.log.info('{{name}} activated');
}

export function deactivate(): void {
  // ctx.subscriptions are disposed automatically.
}
