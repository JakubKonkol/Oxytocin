import { connect } from './oxy-sdk.js';

// Everything the view observed, read by the E2E test through the iframe's DOM.
const report = { messages: [], loadedAt: Date.now() };
const log = document.getElementById('log');
const publish = () => {
  log.textContent = JSON.stringify(report);
  document.body.dataset.report = JSON.stringify(report);
};

try {
  report.parentOxy = typeof window.parent.oxy;
} catch (e) {
  report.parentOxy = `blocked: ${e.name}`;
}
try {
  await fetch('https://example.com/');
  report.fetch = 'allowed';
} catch (e) {
  report.fetch = `blocked: ${e.name}`;
}

const view = await connect();
report.init = {
  viewId: view.viewId,
  kind: view.kind,
  params: view.params,
  hasTheme: !!getComputedStyle(document.documentElement).getPropertyValue('--bg-card'),
};
view.onMessage((m) => {
  report.messages.push(m);
  publish();
});
view.onVisibilityChange((v) => {
  report.visible = v;
  publish();
});
report.sum = await view.request('add', { a: 2, b: 3 });
try {
  await view.request('fail');
} catch (e) {
  report.failError = e.message;
}
view.postMessage({ ping: 1 });
view.setState({ counter: (view.getState()?.counter ?? 0) + 1 });
report.state = view.getState();
publish();
window.oxyView = view;
