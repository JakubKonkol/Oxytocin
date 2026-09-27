# create-oxytocin-plugin

Scaffolds an [Oxytocin](https://github.com/JakubKonkol/Oxytocin) plugin: a TypeScript backend (command, status bar
item, panel provider) and a view (vanilla TypeScript or React) built with esbuild and Vite.

```sh
npm create oxytocin-plugin@latest my-plugin
# non-interactive:
npm create oxytocin-plugin@latest my-plugin -- --id acme.my-plugin --name "My Plugin" --publisher acme --template react --yes
```

From a clone of the Oxytocin repository: `node packages/create-oxytocin-plugin/index.js my-plugin`.

The generated project has `npm run dev` (rebuild on changes), `npm run build`, `npm run typecheck` and
`npm run package` (a .zip for **Plugins → Install from .zip…**). The view SDK and the backend API types are copied
into its `vendor/` folder. See the [plugin documentation](../../docs/plugins/README.md).

Publishing: `npm publish` runs `prepack`, which copies the SDK and API types from the monorepo into `vendor/`.

MIT License.
