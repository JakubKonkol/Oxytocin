import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestFiles, updateManifestProblems } from './lib/update-manifests';

// The latest.yml of the 0.5.1 release, whose installer GitHub renamed to Oxytocin.Setup.0.5.1.exe.
const LATEST_051 = `version: 0.5.1
files:
  - url: Oxytocin-Setup-0.5.1.exe
    sha512: SM1N==
    size: 118877001
path: Oxytocin-Setup-0.5.1.exe
sha512: SM1N==
releaseDate: '2026-09-28T21:42:00.668Z'
`;

describe('update manifests', () => {
  it('lists the files a manifest points at', () => {
    expect(manifestFiles(LATEST_051)).toEqual(['Oxytocin-Setup-0.5.1.exe']);
    expect(manifestFiles("files:\n  - url: 'a b.zip'\n  - url: c.dmg\npath: a b.zip\n")).toEqual(['a b.zip', 'c.dmg']);
  });

  it('accepts packages that match their manifest', () => {
    const files = new Map([
      ['latest.yml', LATEST_051],
      ['Oxytocin-Setup-0.5.1.exe', null],
      ['Oxytocin-Setup-0.5.1.exe.blockmap', null],
    ]);
    expect(updateManifestProblems(files)).toEqual([]);
  });

  it('reports names GitHub changes and manifests pointing at missing files', () => {
    const files = new Map([
      ['latest.yml', LATEST_051],
      ['Oxytocin Setup 0.5.1.exe', null],
    ]);
    expect(updateManifestProblems(files)).toEqual([
      '"Oxytocin Setup 0.5.1.exe" has a space in its name: GitHub renames it on upload.',
      'latest.yml points at "Oxytocin-Setup-0.5.1.exe", which is not among the packages.',
    ]);
    expect(updateManifestProblems(new Map([['Oxytocin.AppImage', null]]))).toEqual([
      'No update manifest (latest*.yml) was found.',
    ]);
  });

  it('electron-builder names every package without spaces', () => {
    const yml = readFileSync(resolve(__dirname, '..', 'electron-builder.yml'), 'utf8');
    const product = /^productName:\s*(.+)$/m.exec(yml)![1]!.trim();
    // Without an artifactName, NSIS uses "${productName} Setup ${version}.${ext}".
    expect(/^nsis:\n(?:\s+.*\n)*?\s+artifactName:/m.test(yml)).toBe(true);
    for (const m of yml.matchAll(/artifactName:\s*(.+)$/gm))
      expect(m[1]!.replaceAll('${productName}', product)).not.toMatch(/\s/);
  });
});
