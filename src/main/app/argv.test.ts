import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectPathsFromArgv } from './argv';

describe('projectPathsFromArgv', () => {
  it('skips the executable, the dev entry and flags', () => {
    expect(
      projectPathsFromArgv(['electron', 'out/main/index.js', '--no-sandbox', '--user-data-dir', '/tmp/u', '/dev/api'], {
        isPackaged: false,
        cwd: '/',
      }),
    ).toEqual(['/dev/api']);
  });

  it('resolves relative paths against the working directory in packaged builds', () => {
    expect(projectPathsFromArgv(['Oxytocin.exe', 'web', '--flag=1'], { isPackaged: true, cwd: '/home/me' })).toEqual([
      resolve('/home/me', 'web'),
    ]);
  });
});
