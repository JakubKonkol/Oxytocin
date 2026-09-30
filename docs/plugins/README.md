# Writing Oxytocin plugins

Oxytocin plugins add panels, sidebar views, status bar items, commands, settings, terminal profiles and terminal
environment variables. A plugin is a folder with a `package.json` (whose `oxytocin` section is the manifest), an
optional **backend** (JavaScript that runs in Oxytocin's Plugin Host, a Node.js process) and optional **views**
(web pages shown in sandboxed iframes).

Plugin API version: **0.1.4** (`packages/plugin-api/CHANGELOG.md`). Until 1.0, minor versions may contain breaking
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
    "engine": "^0.1.4",                  // Oxytocin plugin API versions this plugin supports (semver range)
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
| `onMcpTool:<name>` | An agent calls one of the plugin's MCP tools (see [Tools for AI agents](#tools-for-ai-agents)) |

### Contributions

| Key | Contributes |
|---|---|
| `views` | Sidebar sections: `{ id, slot: "sidebar", title, entry, icon?, order?, initialHeight?, minHeight? }` |
| `panels` | Center-area tabs: `{ type, title, entry, icon?, singleton?: false \| "global" \| "project", showInAddMenu? }` — with `showInAddMenu: true` the panel is a *tool*: it is listed in the workspace's **+** menu and the right sidebar's **Add tool** menu (opened without params) and can be dragged into either sidebar |
| `statusBarItems` | `{ id, alignment?: "left" \| "right", priority? }` — text and visibility are set by the backend |
| `commands` | `{ id, title, icon? }` — listed in the command palette (`Ctrl+Shift+P`) |
| `configuration` | `{ prefix, properties }` — settings shown in **Settings**; every key starts with `<prefix>.` |
| `fileOpeners` | `{ id, extensions, panelType, title, default? }` — opens files from the Changes list and terminal links in a panel (see [File openers](#file-openers)) |
| `terminalProfiles` | `{ id, name, kind?: "shell" \| "agent", command?, args?, env?, icon? }` |
| `agents` | Agent detection rules: `{ id, displayName, provider?, processNames?, commandLinePatterns?, icon? }` |
| `mcp` | Tools for AI agents: `{ prefix, tools }` (see [Tools for AI agents](#tools-for-ai-agents)) |

Setting properties use a JSON-schema subset: `type` (`boolean`, `number`, `integer`, `string`, `array`, `object`),
`default`, `enum` (+ `enumDescriptions`), `minimum`, `maximum`, `description`. Invalid values are rejected in the
Settings UI and fall back to the default.

### Permissions

Permissions guard the `oxy` API and are shown to the user before a plugin they installed runs. Ask only for what you
use.

| Permission | Allows |
|---|---|
| `projects.read` | `oxy.projects.*` |
| `terminals.read-metadata` | `oxy.terminals.list`, `onDidOpen/Close/Change`, `show`, `getListeningPorts` |
| `terminals.create` | `oxy.terminals.create` |
| `terminals.write` | `oxy.terminals.sendText`, `kill`, `close` |
| `terminals.read-output` | `oxy.terminals.onDidWriteData` — raw terminal output (sensitive) |
| `terminals.env` | `oxy.terminals.environment` |
| `agents.read` / `agents.annotate` | `oxy.agents.list/onDidChange` / `reportSession`, `reportState` |
| `git.read` | `oxy.git.*` |
| `notifications.os` | `showNotification({ os: true })` |
| `mcp.tools` | `oxy.mcp.registerTool` and `contributes.mcp` — tools AI agents can call (the consent dialog lists them) |
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

### Running commands in terminals

A plugin can run a command in a terminal of a project, keep it in the background and follow what it does (the
built-in Project Runner is built this way):

```ts
const t = await oxy.terminals.create({
  projectId,
  cwd: '/work/shop/web',
  title: 'web',
  command: 'npm run dev',          // typed into the shell once it is ready
  env: { PORT: '4000' },           // this terminal only; null removes a variable
  reveal: false,                   // no panel until show() — the terminal runs in the background
});

const output = oxy.terminals.onDidWriteData(t.id, (data) => parse(data));   // terminals.read-output
ctx.subscriptions.push(output);

oxy.terminals.onDidChange((meta) => {
  // Shell integration (bash, zsh, fish, PowerShell): the running command and the last one with its exit code.
  if (meta.id === t.id && !meta.command && meta.lastCommand) finished(meta.lastCommand.exitCode);
});

await oxy.terminals.getListeningPorts(t.id);   // e.g. [5173] — ports of the shell and its child processes
await oxy.terminals.show(t.id, { preserveFocus: true });   // opens its panel (logs) when the user asks
await oxy.terminals.sendText(t.id, '\x03', { addNewLine: false });   // Ctrl+C
await oxy.terminals.kill(t.id, { force: true });   // or end the process tree; close() also removes the terminal
```

`TerminalMeta` carries `cwd`, `background`, `foreground` (the nearest non-shell process, e.g. `node`),
`shellIntegration`, `command` and `lastCommand`. Output is only streamed to the Plugin Host while a listener is
registered; dispose it when you no longer need it.

### File openers

`contributes.fileOpeners` connect file extensions to a panel type. The panel opens with the params
`{ projectId, path, line?, column? }` (an absolute path inside the project) when the user picks **Open Preview** in the
Changes list or `Ctrl+click`s a file path in a terminal (the `terminal.fileLinks.open` setting chooses between previews
and the editor; an opener with `default: true` wins when several match). When a panel of that type already shows the
file — in the workspace or a sidebar — it is revealed instead, and its view receives the message
`{ type: 'oxy:reveal', line?, column? }` (`view.onMessage`) to scroll to the new position.

### Tools for AI agents

Oxytocin runs one local MCP server (`oxytocin`) that the user connects Claude Code and other agents to once (*Settings
→ Agent Tools*). Plugins add tools to it; agents see them as soon as the plugin is enabled and lose them when it is
disabled or fails — running Claude Code sessions are told through MCP's `notifications/tools/list_changed`, no
re-connecting needed. Since API 0.1.5.

Declare the tools in the manifest (they are listed before the plugin is activated, and shown in the consent dialog):

```jsonc
"permissions": ["mcp.tools"],
"activationEvents": ["onMcpTool:tests_run"],
"contributes": {
  "mcp": {
    "prefix": "tests",
    "tools": [
      {
        "name": "tests_run",
        "title": "Run tests",
        "description": "Runs the project's tests and returns the failures with file and line.",
        "inputSchema": { "type": "object", "properties": { "filter": { "type": "string" } } },
        "annotations": { "readOnlyHint": false, "destructiveHint": false },
        "timeoutMs": 120000
      }
    ]
  }
}
```

and handle them in the backend:

```ts
ctx.subscriptions.push(
  oxy.mcp.registerTool('tests_run', async (args, context) => {
    const filter = typeof args['filter'] === 'string' ? args['filter'] : undefined; // arguments are untrusted input
    const failures = await runTests(context.projectId, filter, context.signal);
    return failures.length ? failures.join('\n') : 'All tests passed.';
  }),
);
```

- **Names.** One `prefix` per plugin (`^[a-z][a-z0-9]{1,15}$`, `oxy` is reserved); every tool is named `<prefix>_…`
  (`^[a-zA-Z0-9_-]{1,64}$`). Claude Code shows it as `mcp__oxytocin__tests_run`. When two plugins claim a prefix, a
  built-in plugin wins, otherwise the lower plugin id; the other plugin shows an error in the plugin manager.
- **Descriptions** are how agents choose tools: say what the tool does *and when to use it*.
- **Results.** Return a string or `{ content: [{ type: 'text', text } | { type: 'image', data, mimeType }], isError?,
  structuredContent? }`. A thrown error is reported to the agent as a tool error. Text over 256 KB is cut and images
  over 5 MB are left out (with a note to the agent).
- **Context.** `context.projectId` is the project of the calling agent's terminal (else its `cwd` or `project`
  argument, else the active project); `terminalId` and `agentId` are set when known. `context.signal` aborts when the
  agent cancels the call, it times out (`timeoutMs`, default 60 s, at most 10 minutes) or the plugin is deactivated.
- **Asking the user.** `annotations.destructiveHint: true` makes Oxytocin ask before each call (*Allow once*, *Always
  allow*, *Deny*). Users can switch any tool off or change its policy in *Settings → Agent Tools*.
- **Runtime tools.** `oxy.mcp.registerTool(definition, handler)` adds a tool that is not in the manifest (the name still
  starts with the prefix); it is offered while the returned `Disposable` lives.

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
- Every panel can be dragged into the right sidebar, from there to the left sidebar, and back. A panel in a sidebar is
  not tied to a project: `view.projectId` is empty there, so follow the active project
  (`oxy.projects.getActive/onDidChangeActive`) or keep the project in the panel's params. `oxy.ui.openPanel` of a
  `singleton` panel reveals the one already in a sidebar (with the same params) instead of opening another.

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
