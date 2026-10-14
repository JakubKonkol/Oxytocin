import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { connect, freePort } from './helpers/mcp';
import { userDataWithPlugins } from './helpers/plugins';
import { waitForTerminal } from './helpers/terminal';

const text = (r: { result?: { content?: { text: string }[]; isError?: boolean } }) =>
  `${r.result?.isError ? 'ERROR: ' : ''}${r.result?.content?.map((c) => c.text).join('\n') ?? ''}`;

/** A real PostgreSQL server for discovery (see docs/testing-databases.md); without it discovery only fails. */
const PG_URL = process.env['OXY_TEST_PG_URL'];

async function openServers(win: Page) {
  await win.getByTestId('open-settings').click();
  await win.locator('[data-testid="settings-section"][data-section="Database Servers"]').click();
  await expect(win.getByTestId('dbservers-view')).toBeVisible();
  // The section is a view of its own: no settings.json groups under it.
  await expect(win.getByTestId('settings-group')).toHaveCount(0);
}

async function addServer(win: Page, engine: string, o: { name: string; host: string; port: string; user?: string }) {
  await win.getByTestId('dbservers-add').click();
  await win.getByTestId(`dbservers-add-${engine}`).click();
  const form = win.getByTestId('dbserver-form');
  await form.getByTestId('dbserver-name').fill(o.name);
  await form.getByTestId('dbserver-host').fill(o.host);
  await form.getByTestId('dbserver-port').fill(o.port);
  if (o.user) await form.getByTestId('dbserver-user').fill(o.user);
  return form;
}

test('database servers: configured once, discovered, linked to a project and listed to agents by server', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'oxy-e2e-srv-')), 'PROJECT_01');
  await mkdir(root, { recursive: true });
  const port = await freePort();
  const userData = await userDataWithPlugins([], { 'mcp.port': port });
  const { app, win } = await launchApp({ userData, project: root });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await waitForTerminal(win);
    await openServers(win);

    // FIRMA_1: a SQL Server that cannot be reached — discovery explains why; databases can be added by name.
    let form = await addServer(win, 'sqlserver', { name: 'FIRMA_1', host: '127.0.0.1', port: '1', user: 'reader' });
    await form.getByTestId('dbserver-password').fill('Firma1-Secret!');
    await form.getByTestId('dbserver-discover').click();
    await expect(form.getByTestId('dbserver-discover-result')).toHaveAttribute('data-ok', 'false', {
      timeout: 30_000,
    });
    await expect(form.getByTestId('dbserver-discover-result')).not.toContainText('Firma1-Secret!');
    await form.getByTestId('dbserver-db-new').fill('WMS_DB');
    await form.getByTestId('dbserver-db-add').click();
    await expect(form.locator('[data-testid="dbserver-db-item"][data-name="WMS_DB"]')).toBeVisible();

    // FIRMA_02: the same database name on another server.
    form = await addServer(win, 'sqlserver', { name: 'FIRMA_02', host: '127.0.0.2', port: '1' });
    await form.getByTestId('dbserver-db-new').fill('WMS_DB');
    await form.getByTestId('dbserver-db-add').click();

    // A real server is discovered when one is available.
    if (PG_URL) {
      const u = new URL(PG_URL);
      form = await addServer(win, 'postgresql', {
        name: 'PG',
        host: u.hostname,
        port: u.port || '5432',
        user: decodeURIComponent(u.username),
      });
      await form.getByTestId('dbserver-password').fill(decodeURIComponent(u.password));
      await form.getByTestId('dbserver-discover').click();
      await expect(form.getByTestId('dbserver-discover-result')).toHaveAttribute('data-ok', 'true', {
        timeout: 30_000,
      });
      await expect(form.locator('[data-testid="dbserver-found-item"][data-name="bank"]')).toBeVisible();
      // System databases are hidden until asked for.
      await expect(form.locator('[data-testid="dbserver-found-item"][data-name="postgres"]')).toHaveCount(0);
      await form.locator('[data-testid="dbserver-found-item"][data-name="bank"] input').check();
      await form.getByTestId('dbserver-add-picked').click();
      await expect(form.locator('[data-testid="dbserver-db-item"][data-name="bank"]')).toBeVisible();
    }

    await win.getByTestId('dbservers-save').click();
    await expect
      .poll(async () => readFile(join(userData, 'database-servers.json'), 'utf8').catch(() => ''))
      .toContain('FIRMA_02');
    await expect(win.getByTestId('dbservers-save')).toBeDisabled();
    const saved = await readFile(join(userData, 'database-servers.json'), 'utf8');
    expect(saved).toContain('FIRMA_1');
    expect(saved).not.toContain('Firma1-Secret!');
    expect(await readFile(join(userData, 'secrets.json'), 'utf8')).not.toContain('Firma1-Secret!');
    await expect(win.getByTestId('dbservers-list-item')).toHaveCount(PG_URL ? 3 : 2);

    // PROJECT_01 links WMS_DB of both servers (and the discovered database).
    await win.getByTestId('projects-item-PROJECT_01').click({ button: 'right' });
    await win.getByTestId('project-menu-settings').click();
    const dialog = win.getByTestId('project-settings');
    await dialog.getByTestId('project-settings-tab-databases').click();
    await dialog.getByTestId('db-link-open').click();
    await dialog.locator('[data-testid="db-link-item"][data-name="FIRMA_1/WMS_DB"] input').check();
    await dialog.locator('[data-testid="db-link-item"][data-name="FIRMA_02/WMS_DB"] input').check();
    if (PG_URL) await dialog.locator('[data-testid="db-link-item"][data-name="PG/bank"] input').check();
    await dialog.getByTestId('db-link-add').click();
    await expect(dialog.getByTestId('db-list-item')).toHaveCount(PG_URL ? 3 : 2);
    await expect(dialog.locator('[data-testid="db-list-item"][data-name="FIRMA_1/WMS_DB"]')).toBeVisible();
    await dialog.locator('[data-testid="db-list-item"][data-name="FIRMA_02/WMS_DB"]').click();
    await expect(dialog.getByTestId('db-server')).toHaveValue(/.+/);
    await expect(dialog.getByTestId('db-server-database')).toHaveValue('WMS_DB');
    await expect(dialog.getByTestId('db-server-note')).toContainText('127.0.0.2:1');
    await expect(dialog.getByTestId('db-engine')).toBeDisabled();
    await dialog.getByTestId('project-settings-save').click();
    await expect(dialog).toHaveCount(0);

    // Agents see the databases grouped by server.
    await expect.poll(async () => readFile(join(userData, 'mcp.json'), 'utf8').catch(() => '')).toContain('token');
    const token = (JSON.parse(await readFile(join(userData, 'mcp.json'), 'utf8')) as { token: string }).token;
    client = await connect(port, token);
    await expect.poll(() => client!.tools()).toContain('oxy_db_query');
    const resources = text(await client.call('oxy_project_resources', { project: 'PROJECT_01' }));
    expect(resources).toContain('"name": "FIRMA_1/WMS_DB"');
    expect(resources).toContain('"server": "FIRMA_02"');
    expect(resources).toContain('"databaseServers"');
    expect(resources).not.toContain('Firma1-Secret!');
    const unreachable = text(await client.call('oxy_db_schema', { project: 'PROJECT_01', database: 'FIRMA_1/WMS_DB' }));
    expect(unreachable).toMatch(/^ERROR: FIRMA_1\/WMS_DB:/);
    expect(unreachable).not.toContain('Firma1-Secret!');
    if (PG_URL) {
      const read = text(
        await client.call('oxy_db_query', {
          project: 'PROJECT_01',
          database: 'PG/bank',
          query: 'SELECT count(*) AS n FROM users',
        }),
      );
      expect(read).toMatch(/\| \d+ \|/);
    }
  } finally {
    client?.close();
    await app.close();
  }
});
