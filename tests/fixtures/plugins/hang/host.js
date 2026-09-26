export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.oxy.commands.register('hang.forever', () => {
      // Blocks the Plugin Host's event loop: must be detected by the ping and the host restarted.
      for (;;) {
        /* spin */
      }
    }),
  );
}
