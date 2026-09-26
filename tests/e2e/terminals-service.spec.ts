import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

interface MainHooks {
  hosts: { pty: { call(method: string, params: unknown): Promise<unknown> } };
}

test('terminals:create spawns a shell with a composed environment', async () => {
  const { app, win } = await launchApp({ env: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  try {
    await expect(win.getByTestId('app-ready')).toBeVisible();
    const profiles = (await win.evaluate(() => window.oxy.invoke('terminals:profiles'))) as {
      id: string;
      kind: string;
    }[];
    expect(profiles.some((p) => p.kind === 'shell')).toBe(true);

    const info = (await win.evaluate(() =>
      window.oxy.invoke('terminals:create', {
        projectId: 'default',
        initialCommand:
          "node -e \"console.log('ID=' + process.env.OXYTOCIN_TERMINAL_ID + ' CC=' + (process.env.CLAUDECODE || 'unset') + ' TP=' + process.env.TERM_PROGRAM)\"",
      }),
    )) as { id: string; pid: number; state: string; kind: string };
    expect(info.pid).toBeGreaterThan(0);
    expect(info).toMatchObject({ state: 'running', kind: 'shell' });

    await expect
      .poll(
        () =>
          app.evaluate(
            (_e, id) => (globalThis as unknown as { __oxyMain: MainHooks }).__oxyMain.hosts.pty.call('getText', { id }),
            info.id,
          ),
        { timeout: 15_000 },
      )
      .toContain(`ID=${info.id} CC=unset TP=Oxytocin`);

    const list = (await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as { id: string }[];
    expect(list.map((t) => t.id)).toContain(info.id);

    await win.evaluate((id) => window.oxy.invoke('terminals:dispose', { id }), info.id);
    const after = (await win.evaluate(() => window.oxy.invoke('terminals:list', {}))) as { id: string }[];
    expect(after.map((t) => t.id)).not.toContain(info.id);
  } finally {
    await app.close();
  }
});

test('unknown profiles and projects are rejected', async () => {
  const { app, win } = await launchApp();
  try {
    const err = await win.evaluate(() =>
      window.oxy.invoke('terminals:create', { projectId: 'default', profileId: 'nope' }).catch((e: Error) => e.message),
    );
    expect(err).toContain('"code":"NOT_FOUND"');
    const err2 = await win.evaluate(() =>
      window.oxy.invoke('terminals:create', { projectId: 'missing' }).catch((e: Error) => e.message),
    );
    expect(err2).toContain('"code":"NOT_FOUND"');
  } finally {
    await app.close();
  }
});
