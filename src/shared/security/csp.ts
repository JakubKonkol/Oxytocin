/** Content Security Policy of the shell renderer (docs/plan/01-architecture.md §5). */
export const SHELL_CSP_DIRECTIVES: Readonly<Record<string, string>> = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: oxy-plugin:",
  'font-src': "'self' data:",
  'frame-src': 'oxy-plugin:',
  'worker-src': "'self' blob:",
  'connect-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
};

/** Dev server extras: Vite HMR websocket and the React Refresh inline preamble. */
const DEV_EXTRAS: Readonly<Record<string, string>> = {
  'script-src': "'unsafe-inline' http://localhost:*",
  'connect-src': 'ws://localhost:* http://localhost:*',
  'img-src': 'http://localhost:*',
  'font-src': 'http://localhost:*',
  'style-src': 'http://localhost:*',
  'worker-src': 'http://localhost:*',
};

export function buildShellCsp(opts: { dev: boolean }): string {
  return Object.entries(SHELL_CSP_DIRECTIVES)
    .map(([name, value]) => {
      const extra = opts.dev ? DEV_EXTRAS[name] : undefined;
      return `${name} ${extra ? `${value} ${extra}` : value}`;
    })
    .join('; ');
}
