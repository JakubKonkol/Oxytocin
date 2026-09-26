/** CSP of plugin views (docs/plan/07-plugin-engine.md §7.2): no network, nothing from outside the plugin. */
export function buildPluginCsp(pluginId: string, opts: { dev: boolean }): string {
  const self = `oxy-plugin://${pluginId}`;
  const ancestors = opts.dev ? 'app://oxytocin http://localhost:*' : 'app://oxytocin';
  return [
    "default-src 'none'",
    `script-src ${self}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data:`,
    `media-src ${self} blob:`,
    "connect-src 'none'",
    "frame-src 'none'",
    `worker-src ${self} blob:`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}
