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
