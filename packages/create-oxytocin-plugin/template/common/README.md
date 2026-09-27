# {{name}}

An [Oxytocin](https://github.com/JakubKonkol/Oxytocin) plugin (`{{id}}`).

## Develop

```sh
npm install
npm run dev        # rebuilds dist/ on every change
```

In Oxytocin open **Plugins** (puzzle icon in the status bar), turn on **Developer mode**, click
**Load plugin from folder…** and pick this folder. While `npm run dev` runs, Oxytocin reloads the plugin and its views
after every build. **Show logs** in the plugin list shows `ctx.log` output; **Open DevTools** inspects the views.

- `src/host.ts` — the backend (Node.js, runs in Oxytocin's Plugin Host): commands, status bar item, panel provider.
- `src/views/` — the panel (a web page in a sandboxed iframe; talks to the backend through `@oxytocin/plugin-sdk`).
- `package.json` → `oxytocin` — the manifest: id, activation events, permissions and contributions.
- `vendor/` — the view SDK and the backend API types (Oxytocin API {{apiVersion}}).

## Package

```sh
npm run package    # {{id}}-<version>.zip
```

Install the archive with **Plugins → Install from .zip…**. Oxytocin asks for consent before the plugin runs.

See the plugin documentation: https://github.com/JakubKonkol/Oxytocin/blob/main/docs/plugins/README.md
