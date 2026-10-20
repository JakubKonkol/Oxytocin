export function activate(ctx) {
  const { oxy } = ctx;
  const changes = [];
  ctx.subscriptions.push(
    oxy.codeMap.onDidChange((change) => {
      changes.push(change);
      if (changes.length > 100) changes.shift();
    }),
    oxy.commands.register('map.checkouts', (projectId) => oxy.codeMap.listCheckouts(projectId)),
    oxy.commands.register('map.query', (request) => oxy.codeMap.query(request)),
    oxy.commands.register('map.open', (locator) => oxy.codeMap.openSource(locator)),
    oxy.commands.register('map.changes', () => changes.slice()),
  );
}
