import { describe, expect, it } from 'vitest';
import type { DetectedProfile } from './detect';
import {
  findProfile,
  mergeProfiles,
  normalizeConfig,
  overrideFor,
  parseEnvLines,
  validateProfileInput,
} from './profiles';

const web: DetectedProfile = {
  id: 'node:apps/web',
  name: 'web',
  command: 'npm run dev',
  cwd: 'apps/web',
  kind: 'node',
  framework: 'Vite',
};
const api: DetectedProfile = {
  id: 'dotnet:api/Api.csproj',
  name: 'Api',
  command: 'dotnet run',
  cwd: 'api',
  kind: 'dotnet',
};

describe('profiles', () => {
  it('merges detected profiles with edits, hidden ones and custom profiles', () => {
    const config = normalizeConfig({
      hidden: [api.id],
      overrides: { [web.id]: { command: 'npm run dev -- --port 4000', env: { PORT: '4000' } } },
      custom: [{ id: 'custom-1', name: 'worker', command: 'node worker.js', cwd: '' }],
    });
    expect(mergeProfiles([web, api], config)).toEqual([
      {
        ...web,
        command: 'npm run dev -- --port 4000',
        env: { PORT: '4000' },
        source: 'detected',
        edited: true,
      },
      { id: 'custom-1', name: 'worker', command: 'node worker.js', cwd: '', source: 'custom', kind: 'custom' },
    ]);
  });

  it('normalizes broken stored data', () => {
    expect(normalizeConfig(undefined)).toEqual({ custom: [], hidden: [], overrides: {} });
    expect(normalizeConfig({ custom: [{ id: 1 }, null], hidden: 'x' })).toEqual({
      custom: [],
      hidden: [],
      overrides: {},
    });
  });

  it('validates input from the form and from agents', () => {
    expect(
      validateProfileInput({ name: ' api ', command: ' dotnet watch ', cwd: './src/Api/', env: 'A=1\n# c\nB=x=y\n' }),
    ).toEqual({ name: 'api', command: 'dotnet watch', cwd: 'src/Api', env: { A: '1', B: 'x=y' } });
    expect(validateProfileInput({ name: 'w', command: 'x', env: { PORT: 4000 } })).toMatchObject({
      env: { PORT: '4000' },
    });
    expect(() => validateProfileInput({ name: '', command: 'x' })).toThrow(/name/);
    expect(() => validateProfileInput({ name: 'a', command: ' ' })).toThrow(/command/);
    expect(() => validateProfileInput({ name: 'a', command: 'x', cwd: '../other' })).toThrow(/relative/);
    expect(() => validateProfileInput({ name: 'a', command: 'x', cwd: 'C:/abs' })).toThrow(/relative/);
    expect(() => validateProfileInput({ name: 'a', command: 'x', env: { 'BAD NAME': '1' } })).toThrow(/variable/);
    expect(() => validateProfileInput({ name: 'a', command: 'x', url: 'ftp://x' })).toThrow(/URL/);
    expect(parseEnvLines('X\n=1\nY= 2')).toEqual({ Y: ' 2' });
  });

  it('stores only the changed fields of a detected profile', () => {
    expect(overrideFor(web, { name: 'web', command: 'npm run dev', cwd: 'apps/web' })).toBeNull();
    expect(
      overrideFor(web, { name: 'Web UI', command: 'npm run dev', cwd: 'apps/web', url: 'http://localhost:1' }),
    ).toEqual({
      name: 'Web UI',
      url: 'http://localhost:1',
    });
  });

  it('finds profiles by id or name', () => {
    const list = mergeProfiles([web, api], normalizeConfig({}));
    expect(findProfile(list, 'API')?.id).toBe(api.id);
    expect(findProfile(list, web.id)?.name).toBe('web');
    expect(findProfile(list, 'web (Vite)')?.id).toBe(web.id);
    expect(findProfile(list, 'nope')).toBeUndefined();
  });
});
