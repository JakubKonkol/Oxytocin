import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { connect, freePort } from './helpers/mcp';
import { userDataWithPlugins } from './helpers/plugins';
import { activeProjectId, waitForTerminal } from './helpers/terminal';

const text = (r: { result?: { content?: { text: string }[]; isError?: boolean } }) =>
  `${r.result?.isError ? 'ERROR: ' : ''}${r.result?.content?.map((c) => c.text).join('\n') ?? ''}`;

async function openSettings(win: Page, project: string, tab: string) {
  await win.getByTestId(`projects-item-${project}`).click({ button: 'right' });
  await win.getByTestId('project-menu-settings').click();
  const dialog = win.getByTestId('project-settings');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`project-settings-tab-${tab}`).click();
  return dialog;
}

test('project resources: a SQLite database and an API reach agents through the bridge, with the user in control', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-res-')), 'bank');
  await mkdir(join(root, 'data'), { recursive: true });
  const db = new DatabaseSync(join(root, 'data', 'app.db'));
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT, balance INTEGER)');
  for (let i = 1; i <= 25; i++)
    db.exec(`INSERT INTO users (email, password_hash, balance) VALUES ('u${i}@x.com', 'h${i}', ${i * 100})`);
  db.close();
  await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://app:devpw@localhost:5432/bank\n');

  // A local API with an OpenAPI document; it records the headers it gets.
  const seen: IncomingHttpHeaders[] = [];
  const api = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          openapi: '3.0.0',
          info: { title: 'Bank API', version: '1' },
          paths: {
            '/users': {
              get: { operationId: 'listUsers', summary: 'List users', responses: { '200': { description: 'ok' } } },
            },
            '/users/{id}': { delete: { operationId: 'deleteUser', responses: { '204': { description: 'gone' } } } },
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method, echoedAuth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()));
  const apiPort = (api.address() as { port: number }).port;

  const port = await freePort();
  const userData = await userDataWithPlugins([], { 'mcp.port': port });
  const { app, win } = await launchApp({ userData, project: root });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await waitForTerminal(win);
    await expect.poll(async () => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    client = await connect(port, token);
    // No resources yet: the resource tools are not offered.
    expect(await client.tools()).not.toContain('oxy_db_query');

    // Databases: add the SQLite file, test it, save.
    let dialog = await openSettings(win, 'bank', 'databases');
    await dialog.getByTestId('db-add').click();
    await win.getByTestId('db-add-sqlite').click();
    await dialog.getByTestId('db-file').fill('data/app.db');
    await dialog.getByTestId('db-name').fill('bank-db');
    await dialog.getByTestId('db-test').click();
    await expect(dialog.getByTestId('db-test-result')).toContainText(/Connected — SQLite 3/);
    await dialog.getByTestId('db-description').fill('Balances are in cents.');

    // Import finds the .env connection; a reference keeps reading the file.
    await dialog.getByTestId('db-import-open').click();
    const envRow = dialog.locator('[data-testid="db-import-row"][data-engine="postgresql"]');
    await expect(envRow).toHaveCount(1);
    await expect(dialog.locator('[data-testid="db-import-row"][data-engine="sqlite"]')).toHaveCount(1);
    await envRow.getByTestId('db-import-reference').click();
    await expect(dialog.getByTestId('db-list-item')).toHaveCount(2);

    // APIs: the local server with a bearer token.
    await dialog.getByTestId('project-settings-tab-apis').click();
    await dialog.getByTestId('api-add').click();
    await dialog.getByTestId('api-name').fill('bank-api');
    await dialog.getByTestId('api-base-url').fill(`http://127.0.0.1:${apiPort}`);
    await dialog.getByTestId('api-auth').selectOption('bearer');
    await dialog.getByTestId('api-token').fill('tok-SECRET-123');
    await dialog.getByTestId('api-test').click();
    await expect(dialog.getByTestId('api-test-result')).toContainText('HTTP 200');
    await expect(dialog.getByTestId('api-test-result')).toContainText('OpenAPI: 2 paths');
    await dialog.getByTestId('project-settings-save').click();
    await expect(dialog).toHaveCount(0);

    // The secret is encrypted on disk and never comes back to the renderer.
    await expect.poll(async () => readFile(join(userData, 'secrets.json'), 'utf8').catch(() => '')).toContain('api');
    expect(await readFile(join(userData, 'secrets.json'), 'utf8')).not.toContain('tok-SECRET-123');
    const projectId = await activeProjectId(win);
    const status = JSON.stringify(
      await win.evaluate((id) => window.oxy.invoke('resources:get', { projectId: id }), projectId),
    );
    expect(status).toContain('/token');
    expect(status).not.toContain('tok-SECRET-123');

    // Agents: the tools appear without reconnecting.
    await expect.poll(() => client!.tools()).toContain('oxy_db_query');
    expect(await client.tools()).toEqual(
      expect.arrayContaining(['oxy_project_resources', 'oxy_db_schema', 'oxy_api_request', 'oxy_api_describe']),
    );
    await expect.poll(() => client!.events).toContain('notifications/tools/list_changed');
    const resources = text(await client.call('oxy_project_resources', { project: 'bank' }));
    expect(resources).toContain('"bank-db"');
    expect(resources).toContain('Balances are in cents.');
    expect(resources).not.toContain('tok-SECRET-123');
    expect(text(await client.call('oxy_db_schema', { project: 'bank', database: 'bank-db' }))).toContain('users');
    const read = text(
      await client.call('oxy_db_query', {
        project: 'bank',
        database: 'bank-db',
        query: 'SELECT * FROM users ORDER BY id',
      }),
    );
    expect(read).toContain('25 rows.');
    expect(read).toContain('| 1 | u1@x.com | *** | 100 |');
    const refused = text(
      await client.call('oxy_db_query', { project: 'bank', database: 'bank-db', query: 'DELETE FROM users' }),
    );
    expect(refused).toMatch(/^ERROR: .*read-only/);

    // API: auth added by Oxytocin, never shown; disallowed methods refused; OpenAPI summarized.
    const describe = text(await client.call('oxy_api_describe', { project: 'bank', api: 'bank-api' }));
    expect(describe).toContain('GET /users — List users [listUsers]');
    expect(describe).toContain('DELETE /users/{id} [deleteUser] (not allowed)');
    const got = text(
      await client.call('oxy_api_request', { project: 'bank', api: 'bank-api', method: 'GET', path: '/users?page=2' }),
    );
    expect(got).toContain('HTTP 200');
    expect(got).toContain('"path": "/users?page=2"');
    expect(got).not.toContain('tok-SECRET-123');
    expect(seen.at(-1)?.authorization).toBe('Bearer tok-SECRET-123');
    expect(text(await client.call('oxy_api_request', { project: 'bank', method: 'DELETE', path: '/users/1' }))).toMatch(
      /ERROR: DELETE is not allowed/,
    );
    expect(
      text(await client.call('oxy_api_request', { project: 'bank', method: 'GET', path: 'http://evil.example/x' })),
    ).toMatch(/not a full URL/);

    // Ask before writes: the user approves one write and denies the next.
    dialog = await openSettings(win, 'bank', 'databases');
    await dialog.getByTestId('db-list-item').filter({ hasText: 'bank-db' }).click();
    await dialog.getByTestId('db-access-mode').locator('[data-value="confirm-writes"]').click();
    await expect(dialog.getByTestId('db-mode-note')).toContainText('asks you first');
    await dialog.getByTestId('project-settings-save').click();
    await expect(dialog).toHaveCount(0);
    const update = client.call('oxy_db_query', {
      project: 'bank',
      database: 'bank-db',
      query: 'UPDATE users SET balance = 0 WHERE id = 1',
    });
    const confirm = win.getByRole('alertdialog');
    await expect(confirm).toContainText('Allow UPDATE on bank-db?');
    await expect(confirm).toContainText('UPDATE users SET balance = 0 WHERE id = 1');
    await confirm.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(text(await update)).toContain('committed');
    const denied = client.call('oxy_db_query', {
      project: 'bank',
      database: 'bank-db',
      query: 'DELETE FROM users WHERE id = 2',
    });
    await expect(confirm).toContainText('Allow DELETE on bank-db?');
    await confirm.getByRole('button', { name: 'Deny' }).click();
    expect(text(await denied)).toMatch(/ERROR: The user denied/);
    expect(
      text(
        await client.call('oxy_db_query', {
          project: 'bank',
          database: 'bank-db',
          query: 'SELECT balance FROM users WHERE id IN (1, 2) ORDER BY id',
        }),
      ),
    ).toMatch(/\| 0 \|\n\| 200 \|/);

    // The Agents tab shows the brief and this project's calls with their queries.
    dialog = await openSettings(win, 'bank', 'agents');
    await expect(dialog.getByTestId('agents-brief')).toContainText(
      'database "bank-db" (SQLite, local, writes ask the user)',
    );
    await expect(dialog.getByTestId('agents-log-row').filter({ hasText: 'UPDATE users SET balance = 0' })).toHaveCount(
      1,
    );
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    client?.close();
    api.close();
    await app.close();
  }
});
