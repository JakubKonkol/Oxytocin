import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticFileHandler, mimeTypeFor, resolveAssetPath } from './app-protocol-handler';

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'oxy-proto-'));
  root = join(base, 'renderer');
  outside = join(base, 'secret.txt');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Oxytocin</title>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(outside, 'secret');
});

afterAll(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('resolveAssetPath', () => {
  it('maps the root to index.html', () => {
    expect(resolveAssetPath(root, 'app://oxytocin/', 'oxytocin')).toBe(join(root, 'index.html'));
  });

  it('never resolves outside the root (plain, encoded and backslash traversal)', () => {
    const attempts = [
      'app://oxytocin/../secret.txt',
      'app://oxytocin/%2e%2e/secret.txt',
      'app://oxytocin/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      'app://oxytocin/..%5Csecret.txt',
      'app://oxytocin/%00',
    ];
    for (const url of attempts) {
      const resolved = resolveAssetPath(root, url, 'oxytocin');
      expect(resolved, url).not.toBe(outside);
      if (resolved !== null) expect(resolved.startsWith(root + sep), url).toBe(true);
    }
    expect(resolveAssetPath(root, 'app://oxytocin/assets/%2e%2e%2f%2e%2e%2fsecret.txt', 'oxytocin')).toBeNull();
    expect(resolveAssetPath(root, 'app://oxytocin/..%5Csecret.txt', 'oxytocin')).toBeNull();
  });

  it('rejects foreign hosts', () => {
    expect(resolveAssetPath(root, 'app://evil/index.html', 'oxytocin')).toBeNull();
  });
});

describe('createStaticFileHandler', () => {
  const handler = () =>
    createStaticFileHandler({
      rootDir: root,
      host: 'oxytocin',
      htmlHeaders: { 'Content-Security-Policy': "default-src 'self'" },
    });

  it('serves files with a content type and CSP on HTML', async () => {
    const res = await handler()(new Request('app://oxytocin/index.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(await res.text()).toContain('Oxytocin');
  });

  it('does not add CSP to scripts', async () => {
    const res = await handler()(new Request('app://oxytocin/assets/app.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('returns 404 for traversal attempts and missing files', async () => {
    for (const url of ['app://oxytocin/%2e%2e/secret.txt', 'app://oxytocin/missing.js', 'app://oxytocin/assets']) {
      const res = await handler()(new Request(url));
      expect(res.status, url).toBe(404);
    }
  });

  it('rejects non-GET methods', async () => {
    const res = await handler()(new Request('app://oxytocin/index.html', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
});

describe('mimeTypeFor', () => {
  it('falls back to octet-stream', () => {
    expect(mimeTypeFor('a.woff2')).toBe('font/woff2');
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
  });
});
