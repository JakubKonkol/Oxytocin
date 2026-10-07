import { describe, expect, it } from 'vitest';
import type { DetectEntry, DetectFs } from './detect';
import {
  fileScriptCommand,
  findScripts,
  inlineFileName,
  inlineFileText,
  normalizeScriptFile,
  scriptCommand,
  scriptFilePath,
  scriptFolder,
} from './scripts';

function memoryFs(files: string[]): DetectFs {
  return {
    list(rel) {
      const prefix = rel ? `${rel}/` : '';
      const entries = new Map<string, DetectEntry>();
      for (const f of files) {
        if (!f.startsWith(prefix)) continue;
        const [name, ...rest] = f.slice(prefix.length).split('/');
        entries.set(name!, { name: name!, dir: rest.length > 0 });
      }
      return Promise.resolve([...entries.values()]);
    },
    readText: () => Promise.resolve(null),
  };
}

describe('custom scripts', () => {
  it('runs a script file with the program its extension needs', () => {
    expect(scriptCommand('start.bat', 'win32')).toBe('cmd /c "start.bat"');
    expect(scriptCommand('tools/My Build.cmd', 'win32')).toBe('cmd /c "tools\\My Build.cmd"');
    expect(scriptCommand('deploy.ps1', 'win32')).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "deploy.ps1"',
    );
    expect(scriptCommand('deploy.ps1', 'linux')).toBe("pwsh -NoProfile -File 'deploy.ps1'");
    expect(scriptCommand("scripts/it's.sh", 'darwin')).toBe("bash 'scripts/it'\\''s.sh'");
    expect(scriptCommand('setup.zsh', 'darwin')).toBe("zsh 'setup.zsh'");
    expect(scriptCommand('tool.py', 'win32')).toBe('python "tool.py"');
    expect(scriptCommand('tool.mjs', 'linux')).toBe("node 'tool.mjs'");
    // Other files run as executables (with their associated program on Windows).
    expect(scriptCommand('run', 'linux')).toBe("'./run'");
    expect(scriptCommand('bin/run', 'linux')).toBe("'bin/run'");
    expect(scriptCommand('tool.exe', 'win32')).toBe('cmd /c "tool.exe"');
  });

  it('runs a project script relative to its folder, a script outside the project by its path', () => {
    expect(fileScriptCommand('scripts/start.bat', 'scripts', 'win32')).toBe('cmd /c "start.bat"');
    expect(fileScriptCommand('scripts/start.bat', '', 'win32')).toBe('cmd /c "scripts\\start.bat"');
    expect(fileScriptCommand('scripts/start.sh', 'apps/web', 'linux')).toBe("bash '../../scripts/start.sh'");
    expect(fileScriptCommand('D:\\tools\\deploy.bat', 'scripts', 'win32')).toBe('cmd /c "D:\\tools\\deploy.bat"');
  });

  it('stores script files relative to the project root when they are inside it', () => {
    expect(normalizeScriptFile('scripts\\start.bat', 'C:\\work\\app', 'win32')).toBe('scripts/start.bat');
    expect(normalizeScriptFile('"C:\\work\\app\\scripts\\start.bat"', 'C:\\work\\app', 'win32')).toBe(
      'scripts/start.bat',
    );
    expect(normalizeScriptFile('./scripts/start.sh', '/work/app', 'linux')).toBe('scripts/start.sh');
    expect(normalizeScriptFile('D:\\tools\\deploy.bat', 'C:\\work\\app', 'win32')).toBe('D:\\tools\\deploy.bat');
    expect(normalizeScriptFile('../shared/deploy.sh', '/work/app', 'linux')).toBe('/work/shared/deploy.sh');
    expect(() => normalizeScriptFile('  ', '/work/app', 'linux')).toThrow('Choose a script file');
    expect(() => normalizeScriptFile('.', '/work/app', 'linux')).toThrow('not the project folder');
  });

  it('resolves stored script files and their folders', () => {
    expect(scriptFilePath('scripts/start.bat', 'C:\\work\\app', 'win32')).toBe('C:\\work\\app\\scripts\\start.bat');
    expect(scriptFilePath('/opt/deploy.sh', '/work/app', 'linux')).toBe('/opt/deploy.sh');
    expect(scriptFolder('scripts/ci/start.sh', 'linux')).toBe('scripts/ci');
    expect(scriptFolder('start.sh', 'linux')).toBe('');
    expect(scriptFolder('D:\\tools\\deploy.bat', 'win32')).toBe('');
  });

  it('saves written scripts in the form their shell reads', () => {
    expect(inlineFileName('custom-1a2b', 'cmd')).toBe('custom-1a2b.cmd');
    expect(inlineFileName('custom:x', 'powershell')).toBe('custom_x.ps1');
    expect(inlineFileText('@echo off\necho hi\npause', 'cmd')).toBe('@echo off\r\necho hi\r\npause\r\n');
    expect(inlineFileText('echo hi\r\n\r\n', 'sh')).toBe('echo hi\n');
    expect(inlineFileText('Write-Host "zażółć"', 'powershell')).toBe('\uFEFFWrite-Host "zażółć"\n');
  });

  it('finds the script files of a project, skipping dependencies and hidden folders', async () => {
    const fs = memoryFs([
      'start.bat',
      'README.md',
      'scripts/deploy.ps1',
      'scripts/ci/test.sh',
      'scripts/notes.txt',
      'node_modules/pkg/install.sh',
      '.git/hooks/pre-commit.sh',
      'a/b/c/d/e/deep.sh',
    ]);
    expect(await findScripts(fs)).toEqual(['start.bat', 'scripts/deploy.ps1', 'scripts/ci/test.sh']);
    expect(await findScripts(fs, { maxDepth: 5 })).toContain('a/b/c/d/e/deep.sh');
    expect(await findScripts(fs, { limit: 1 })).toEqual(['start.bat']);
  });
});
