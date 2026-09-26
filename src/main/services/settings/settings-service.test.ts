import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@shared/logging/logger';
import { SettingsService } from './settings-service';

const silent: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oxy-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsService', () => {
  it('uses defaults when settings.json is missing', () => {
    const s = new SettingsService(join(dir, 'settings.json'), 'win32', silent);
    expect(s.loadSync()['terminal.fontSize']).toBe(13);
    expect(s.loadInfo.status).toBe('missing');
  });

  it('reads JSONC and reports invalid values', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{\n  // bigger font\n  "terminal.fontSize": 16,\n  "terminal.renderer": "canvas",\n}');
    const s = new SettingsService(file, 'linux', silent);
    const settings = s.loadSync();
    expect(settings['terminal.fontSize']).toBe(16);
    expect(settings['terminal.renderer']).toBe('dom');
    expect(s.problems.map((p) => p.key)).toEqual(['terminal.renderer']);
  });

  it('falls back to defaults for a corrupt file and moves it aside', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{ "terminal.fontSize": ');
    const s = new SettingsService(file, 'linux', silent);
    expect(s.loadSync()['terminal.fontSize']).toBe(13);
    expect(s.loadInfo.status).toBe('corrupt');
    expect(s.loadInfo.corruptPath).toContain('settings.json.corrupt-');
  });

  it('fires onDidChange when a reload changes values', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{}');
    const s = new SettingsService(file, 'linux', silent);
    s.loadSync();
    const listener = vi.fn();
    s.onDidChange(listener);
    await writeFile(file, '{ "terminal.fontSize": 20 }');
    await s.reload();
    await s.reload();
    expect(listener).toHaveBeenCalledOnce();
    expect(s.get()['terminal.fontSize']).toBe(20);
  });
});
