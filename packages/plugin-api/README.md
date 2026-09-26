# @oxytocin/plugin-api

Type definitions for the backend (`main` entry) of Oxytocin plugins. A plugin's backend is an ES module that exports
`activate(ctx)` and optionally `deactivate()`; everything else is reached through `ctx.oxy`.

```ts
import type { PluginContext } from '@oxytocin/plugin-api';

export function activate(ctx: PluginContext): void {
  ctx.subscriptions.push(ctx.oxy.commands.register('hello.say', () => ctx.log.info('Hello!')));
}
```

Methods guarded by a permission throw an error with `code: 'PERMISSION'` when the manifest does not declare it.
See `docs/plan/07-plugin-engine.md` in the Oxytocin repository for the manifest format.
