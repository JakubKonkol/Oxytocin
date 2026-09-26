// Test plugin backend for views: answers requests, echoes messages and pushes updates.
export function activate(ctx) {
  const provider = {
    resolve(view) {
      view.onRequest('add', ({ a, b }) => a + b);
      view.onRequest('fail', () => {
        throw new Error('intentional failure');
      });
      view.onDidReceiveMessage((msg) => void view.postMessage({ echo: msg, visible: view.visible }));
      view.onDidChangeVisibility((visible) => void view.postMessage({ visibility: visible }));
      view.title = `Backend title ${view.kind}`;
      void view.postMessage({ hello: view.id, kind: view.kind, params: view.params ?? null });
    },
  };
  ctx.subscriptions.push(ctx.oxy.ui.registerPanelProvider('views.panel', provider));
  ctx.subscriptions.push(ctx.oxy.ui.registerViewProvider('views.sidebar', provider));
}
