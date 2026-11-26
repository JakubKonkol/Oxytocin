import { mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSize, jsonOutline, previewOf, RESULT_FILE_KEEP_COUNT, saveResultFile, savedNote } from './result-file';

const project = () => mkdtemp(join(tmpdir(), 'oxy-results-'));

describe('saveResultFile', () => {
  it('saves into .oxy/results, which ignores itself in git', async () => {
    const root = await project();
    const saved = await saveResultFile({
      root,
      label: 'bank-api GET /users?page=2',
      extension: 'json',
      data: '{"a":1}',
      now: new Date(2026, 10, 26, 9, 5, 7),
    });
    expect(saved.relativePath).toMatch(/^\.oxy\/results\/20261126-090507-bank-api-get-users-page-2-[0-9a-f]{6}\.json$/);
    expect(saved.bytes).toBe(7);
    expect(await readFile(saved.path, 'utf8')).toBe('{"a":1}');
    expect(await readFile(join(root, '.oxy', 'results', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    expect(savedNote(saved, 'The body')).toContain(`The body saved in full (7 B) to ${saved.relativePath}`);
  });

  it('removes results older than a day and keeps at most the newest ones', async () => {
    const root = await project();
    const dir = join(root, '.oxy', 'results');
    await mkdir(dir, { recursive: true });
    const old = join(dir, 'old.json');
    await writeFile(old, 'x');
    const dayAgo = (Date.now() - 25 * 60 * 60_000) / 1000;
    await utimes(old, dayAgo, dayAgo);
    for (let i = 0; i < RESULT_FILE_KEEP_COUNT + 5; i++) {
      const path = join(dir, `r${i}.json`);
      await writeFile(path, 'x');
      const at = (Date.now() - (100 - i) * 1000) / 1000;
      await utimes(path, at, at);
    }
    const saved = await saveResultFile({ root, label: 'new', extension: 'json', data: 'y' });
    const left = (await readdir(dir)).filter((f) => f !== '.gitignore');
    expect(left).toHaveLength(RESULT_FILE_KEEP_COUNT);
    expect(left).not.toContain('old.json');
    expect(left).not.toContain('r0.json');
    expect(left).toContain(`r${RESULT_FILE_KEEP_COUNT + 4}.json`);
    expect((await stat(saved.path)).size).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('refuses a .oxy that leads out of the project', async () => {
    const root = await project();
    const elsewhere = await project();
    await symlink(elsewhere, join(root, '.oxy'));
    await expect(saveResultFile({ root, label: 'x', extension: 'json', data: '1' })).rejects.toThrow(
      /not a plain folder/,
    );
  });
});

describe('result helpers', () => {
  it('outlines the shape of JSON', () => {
    const outline = jsonOutline({
      data: [
        { id: 1, name: 'a', tags: ['x'] },
        { id: 2, name: 'b', note: null, extra: { deep: true } },
      ],
      meta: { page: 1, total: 12345 },
    });
    expect(outline).toBe(
      [
        '{',
        '  "data": array[2] of {',
        '    "id": number',
        '    "name": string',
        '    "tags": array[1] of string',
        '    "note": null',
        '    "extra": {',
        '      "deep": boolean',
        '    }',
        '  }',
        '  "meta": {',
        '    "page": number',
        '    "total": number',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(jsonOutline([1, 2, 3])).toBe('array[3] of number');
    expect(jsonOutline({ a: 1, b: 2, c: 3 }, 2).split('\n')).toHaveLength(3);
  });

  it('previews the start of a text at a line end and sizes bytes', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const preview = previewOf(text, 100);
    expect(preview.endsWith('\n…')).toBe(true);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(104);
    expect(text.startsWith(preview.slice(0, -2))).toBe(true);
    expect(previewOf('żółć'.repeat(10), 7)).not.toContain('�');
    expect(previewOf('short')).toBe('short');
    expect([formatSize(512), formatSize(1536), formatSize(300 * 1024), formatSize(3.5 * 1024 * 1024)]).toEqual([
      '512 B',
      '1.5 KB',
      '300 KB',
      '3.5 MB',
    ]);
  });
});
