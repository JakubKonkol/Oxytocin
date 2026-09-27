# @oxytocin/plugin-sdk

SDK for plugin views. A view is a web page served from `oxy-plugin://<pluginId>/…` inside a sandboxed iframe; it talks
to the shell and to the plugin backend only through the SDK:

```ts
import { connect } from '@oxytocin/plugin-sdk';
import '@oxytocin/plugin-sdk/theme.css';

const view = await connect();
view.onMessage((msg) => render(msg));
const data = await view.request('load', { page: 1 });
view.setTitle('My view');
```

Views have no network access (`connect-src 'none'`) and no access to the shell's DOM; fetch data through the backend.

## Themes

The shell's design tokens (`--bg-card`, `--text-primary`, `--accent`, …) are applied as CSS variables on `<html>`,
and `data-oxy-theme` is `dark` or `light`. When the user switches the theme, the tokens are replaced and
`view.onThemeChange(tokens)` fires; with React, `useOxyTheme()` (from `@oxytocin/plugin-sdk/react`) re-renders
components that read token values imperatively (charts, canvases). Styles that only use `var(--…)` need nothing.
