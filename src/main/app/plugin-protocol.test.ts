import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginProtocolHandler } from './plugin-protocol';

let base: string;
let root: string;
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'oxy-plg-proto-')));
  root = join(base, 'plugin');
  await mkdir(join(root, 'views'), { recursive: true });
  await writeFile(join(root, 'views', 'a.html'), '<p>view</p>');
  await writeFile(join(base, 'secret.txt'), 'secret');
  try {
    await symlink(join(base, 'secret.txt'), join(root, 'views', 'link.txt'));
  } catch {
    // symlinks may be unavailable (Windows without privilege)
  }
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const handler = () =>
  createPluginProtocolHandler({ pluginRoot: (id) => (id === 'test.view' ? root : null), dev: false });
const get = (url: string) => handler()(new Request(url));

describe('oxy-plugin:// protocol', () => {
  it('serves plugin files with the view CSP', async () => {
    const res = await get('oxy-plugin://test.view/views/a.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>view</p>');
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('script-src oxy-plugin://test.view');
    expect(csp).toContain('frame-ancestors app://oxytocin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each([
    'oxy-plugin://test.view/../secret.txt',
    'oxy-plugin://test.view/views/..%2F..%2Fsecret.txt',
    'oxy-plugin://test.view/views/%5C..%5C..%5Csecret.txt',
    'oxy-plugin://test.view/%2Fetc%2Fpasswd',
    'oxy-plugin://test.view/views/link.txt',
    'oxy-plugin://other.plugin/views/a.html',
    'oxy-plugin://test.view/views/missing.html',
  ])('returns 404 for %s', async (url) => {
    expect((await get(url)).status).toBe(404);
  });
});
