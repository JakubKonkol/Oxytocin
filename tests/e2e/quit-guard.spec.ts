import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { oxyTest, waitForTerminal } from './helpers/terminal';

test('quitting with a running agent asks for confirmation', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'oxy-e2e-'));
  // A user-defined agent profile: the shell runs a long-lived node process as the "agent".
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({
      'terminal.profiles': [
        {
          id: 'agent:fake',
          name: 'Fake Agent',
          kind: 'agent',
          command: 'node -e "setInterval(() => {}, 1000)"',
          source: 'user',
        },
      ],
    }),
  );
  const project = await mkdtemp(join(tmpdir(), 'oxy-e2e-project-'));
  const { app, win } = await launchApp({ userData, project });
  try {
    await waitForTerminal(win);
    await win.evaluate(() => window.oxy.invoke('terminals:create', { projectId: 'default', profileId: 'agent:fake' }));
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] = 'cancel';
    });
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await win.waitForTimeout(500);
    expect(await oxyTest(win).terminalIds()).not.toHaveLength(0);
    expect(app.windows()).toHaveLength(1);
    await app.evaluate(() => {
      (globalThis as Record<string, unknown>)['__oxyQuitGuardAnswer'] = 'quit';
    });
  } finally {
    await app.close();
  }
});
