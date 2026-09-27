# Writing Oxytocin plugins

Oxytocin plugins add panels, sidebar views, status bar items, commands, settings, terminal profiles and terminal
environment variables. A plugin is a folder with a `package.json` (whose `oxytocin` section is the manifest), an
optional **backend** (JavaScript that runs in Oxytocin's Plugin Host, a Node.js process) and optional **views**
(web pages shown in sandboxed iframes).

Plugin API version: **0.1.1** (`packages/plugin-api/CHANGELOG.md`). Until 1.0, minor versions may contain breaking
changes; declare the versions you support with `engine`.

## Quick start

```sh
npm create oxytocin-plugin@latest my-plugin      # or: node <oxytocin repo>/packages/create-oxytocin-plugin/index.js my-plugin
cd my-plugin
npm install
npm run dev
```

The generator asks for the plugin id (`publisher.name`), the display name, the publisher and a template (`vanilla`
TypeScript or `react`). The project contains a backend with a command, a status bar item and a panel whose view asks
the backend for data.

In Oxytocin, open **Plugins** (the puzzle icon in the status bar or *Plugins: Show Plugins* in the command palette),
turn on **Developer mode** and use **Load plugin from folder…**. While `npm run dev` runs, every build reloads the
plugin and its views. `npm run package` creates `<id>-<version>.zip`, which anyone can install with **Install from
.zip…**.

## Anatomy

```
my-plugin/
  package.json           # npm metadata + the "oxytocin" manifest
  src/host.ts            # backend → dist/host.js (ES module, dependencies bundled)
  src/views/main.html    # a view → dist/views/ (relative asset paths)
  vendor/                # @oxytocin/plugin-sdk (views) and @oxytocin/plugin-api types (backend)
  build.mjs              # esbuild + Vite; --watch, --zip
```

Oxytocin only needs `package.json` and the files the manifest points to (`dist/` in the template); `README.md`,
`LICENSE` and `icon.png`/`icon.svg` are shown when present.

## The manifest

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "oxytocin": {
    "id": "acme.my-plugin",              // lowercase, dot-separated; also the host of oxy-plugin://acme.my-plugin/
    "displayName": "My Plugin",
    "description": "What it does.",
    "publisher": "acme",
    "engine": "^0.1.1",                  // Oxytocin plugin API versions this plugin supports (semver range)
    "main": "dist/host.js",              // backend entry; omit for view-only plugins
    "activationEvents": ["onStartup"],
    "permissions": ["projects.read"],
    "contributes": { /* see below */ }
  }
}
```

### Activation events

The backend is imported and `activate(ctx)` runs on the first matching event:

| Event | When |
|---|---|
| `onStartup`, `*` | When Oxytocin starts (keep `activate` fast: it has 5 s before a warning) |
| `onProjectOpen` | A project becomes active |
| `onCommand:<id>` | One of the plugin's commands runs |
| `onView:<id>` / `onPanel:<type>` | One of its views or panels opens |
| `onAgentDetected:<agentId>` | An AI agent (e.g. `claude-code`) is detected in a terminal |

### Contributions

| Key | Contributes |
|---|---|
| `views` | Sidebar sections: `{ id, slot: "sidebar", title, entry, icon?, order?, initialHeight?, minHeight? }` |
| `panels` | Center-area tabs: `{ type, title, entry, icon?, singleton?: false \| "global" \| "project" }` |
| `statusBarItems` | `{ id, alignment?: "left" \| "right", priority? }` — text and visibility are set by the backend |
| `commands` | `{ id, title, icon? }` — listed in the command palette (`Ctrl+Shift+P`) |
| `configuration` | `{ prefix, properties }` — settings shown in **Settings**; every key starts with `<prefix>.` |
| `fileOpeners` | `{ id, extensions, panelType, title, default? }` — opens files from the Changes list in a panel |
| `terminalProfiles` | `{ id, name, kind?: "shell" \| "agent", command?, args?, env?, icon? }` |
| `agents` | Agent detection rules: `{ id, displayName, provider?, processNames?, commandLinePatterns?, icon? }` |

Setting properties use a JSON-schema subset: `type` (`boolean`, `number`, `integer`, `string`, `array`, `object`),
`default`, `enum` (+ `enumDescriptions`), `minimum`, `maximum`, `description`. Invalid values are rejected in the
Settings UI and fall back to the default.

### Permissions

Permissions guard the `oxy` API and are shown to the user before a plugin they installed runs. Ask only for what you
use.

| Permission | Allows |
|---|---|
| `projects.read` | `oxy.projects.*` |
| `terminals.read-metadata` | `oxy.terminals.list`, `onDidOpen/Close/Change` |
| `terminals.create` | `oxy.terminals.create` |
| `terminals.write` | `oxy.terminals.sendText` |
| `terminals.read-output` | Raw terminal output (sensitive) |
| `terminals.env` | `oxy.terminals.environment` |
| `agents.read` / `agents.annotate` | `oxy.agents.list/onDidChange` / `reportSession` |
| `git.read` | `oxy.git.*` |
| `notifications.os` | `showNotification({ os: true })` |
| `fs.read-project`, `fs.read-home`, `net.listen-local`, `net.fetch` | Informational: declare what the backend does with Node APIs |

## The backend

```ts
import type { PluginContext } from '@oxytocin/plugin-api';

export function activate(ctx: PluginContext): void {
  const { oxy } = ctx;
  ctx.subscriptions.push(
    oxy.commands.register('my-plugin.hello', async () => {
      await oxy.ui.showNotification({ level: 'info', message: 'Hello!' });
    }),
  );
}

export function deactivate(): void {}
```

- `ctx.oxy` — the API (`projects`, `terminals`, `agents`, `git`, `ui`, `commands`, `settings`); the full, documented
  types are in `@oxytocin/plugin-api` (`vendor/plugin-api/index.d.ts` in generated projects).
- `ctx.subscriptions` — push every `Disposable`; they are disposed when the plugin is disabled, reloaded or Oxytocin
  quits (`deactivate` has 2 s).
- `ctx.storage` — `globalDir` / `projectDir(id)` for your files, and a small JSON key/value store (`get/set/delete`,
  1 MB in total).
- `ctx.log` — `debug/info/warn/error`; shown under **Show logs** in the plugin list and written to Oxytocin's log.
- The backend is plain Node.js: use `node:fs`, `node:child_process`, `fetch`, npm packages (bundled by `build.mjs`).
  Heavy work belongs in a worker thread — a plugin that blocks the event loop for 15 s gets its Plugin Host restarted
  and, after the second time, is disabled until Oxytocin restarts.

### Status bar items, commands and settings

```ts
const item = oxy.ui.statusBarItem('my-plugin.status');   // declared in contributes.statusBarItems
item.text = '$(pulse) 42';                                 // codicons: $(name)
item.command = 'my-plugin.open';
item.show();

const greeting = oxy.settings.get<string>('my-plugin.greeting');
ctx.subscriptions.push(oxy.settings.onDidChange('my-plugin.', () => refresh()));
```

`oxy.commands.execute` runs commands of other plugins and these core commands: `oxytocin.terminal.new`,
`oxytocin.terminal.focus`, `oxytocin.project.activate`, `oxytocin.diff.open`, `oxytocin.changes.refresh`,
`oxytocin.panel.focus`. `oxy.ui.showQuickPick(items)` lets the user pick an item in the command palette.

### Terminal environment

```ts
oxy.terminals.environment.replace('MY_TOKEN', token, { projectId });
oxy.terminals.environment.append('PATH', '/opt/my-tool/bin');
oxy.terminals.environment.ready(); // new terminals wait up to 2 s at start-up for onStartup plugins that call this
```

Running terminals are marked as out of date (⟳) when the environment changes.

## Views

A view is an HTML page served from `oxy-plugin://<id>/…` in a sandboxed iframe. It has no Node.js, no access to the
shell's DOM and **no network** (`connect-src 'none'`; scripts, styles, images and fonts must come from the plugin's own
files). It talks to the shell and the backend through `@oxytocin/plugin-sdk`:

```ts
import { connect } from '@oxytocin/plugin-sdk';
import '@oxytocin/plugin-sdk/theme.css';

const view = await connect();
const data = await view.request('load', { page: 1 });   // answered by view.onRequest('load', …) in the backend
view.onMessage((msg) => render(msg));                    // from postMessage in the backend
view.setTitle('My view');
view.setState({ page: 1 });                              // restored when the view is recreated (≤ 256 KB)
```

The backend provides views and panels:

```ts
oxy.ui.registerPanelProvider('my-plugin.main', {
  resolve(view) {
    view.title = 'My Plugin';
    view.onRequest('load', async ({ page }) => loadPage(page));
    view.onDidChangeVisibility((visible) => (visible ? resume() : pause()));
  },
});
```

With React, `useOxyView()`, `useOxyMessage()` and `useOxyTheme()` come from `@oxytocin/plugin-sdk/react`.

- **Theme:** the shell's design tokens are CSS variables on `<html>` (`--bg-card`, `--text-primary`,
  `--text-secondary`, `--accent`, `--border-default`, …) and `data-oxy-theme` is `dark` or `light`. Styles that only use
  `var(--…)` follow theme switches automatically.
- **Keyboard:** Oxytocin's shortcuts keep working while a view has focus.
- **Limits:** messages up to 1 MB and 200 per second per view.
- Views stay loaded when they are moved between groups; they are recreated after a restart (use `setState`).

## Debugging

- **Show logs** in the plugin list: the last 500 `ctx.log` entries.
- **Open DevTools** (developer mode): pick the view's frame in the console's context selector.
- Backend: start Oxytocin with `OXYTOCIN_INSPECT_HOSTS=1` and attach from `chrome://inspect` — port 9233 is the Plugin
  Host of installed and developer plugins (9232 runs the built-in ones).
- **Reload** in the plugin list reloads the backend module and the views without restarting Oxytocin.

## Distribution and security

- `npm run package` → a .zip with `package.json`, `dist/`, `README.md`, `LICENSE` and the icon. Users install it with
  **Plugins → Install from .zip…** (or a folder with **Install from folder…**); it is copied to
  `<user data>/plugins/<id>`. Installing a newer version replaces the old one.
- Before a plugin the user installed runs for the first time, Oxytocin shows its publisher, its permissions and — when
  it has a backend — the warning that plugins with a backend have full access to the computer. When an update changes
  the permissions or adds a backend, the plugin is disabled until the user agrees again.
- **Backends are not sandboxed.** Permissions limit the `oxy` API, not Node.js. Installed and developer plugins run in
  their own Plugin Host, separate from the built-in plugins, so a crash or a hang does not affect those.
- There is no marketplace or signature check yet: publish your plugin's source and release archives where users can
  review them.
