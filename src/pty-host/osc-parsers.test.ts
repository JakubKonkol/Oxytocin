import { describe, expect, it } from 'vitest';
import { parseOsc633, parseOsc7, parseOsc777, parseOsc9, unescapeOsc633 } from './osc-parsers';

describe('parseOsc9', () => {
  it('parses progress sequences', () => {
    expect(parseOsc9('4;1;42')).toEqual({ kind: 'progress', state: 1, value: 42 });
    expect(parseOsc9('4;3')).toEqual({ kind: 'progress', state: 3 });
    expect(parseOsc9('4;0;')).toEqual({ kind: 'progress', state: 0 });
    expect(parseOsc9('4;9;1')).toBeNull();
    expect(parseOsc9('4;1;500')).toEqual({ kind: 'progress', state: 1 });
  });

  it('parses notifications and ignores other numeric sub-commands', () => {
    expect(parseOsc9('Build finished')).toEqual({ kind: 'notification', body: 'Build finished' });
    expect(parseOsc9('9;C:\\x')).toBeNull();
    expect(parseOsc9('')).toBeNull();
  });
});

describe('parseOsc777', () => {
  it('parses notify', () => {
    expect(parseOsc777('notify;Claude;Needs input; now')).toEqual({ title: 'Claude', body: 'Needs input; now' });
    expect(parseOsc777('notify;;body')).toEqual({ body: 'body' });
    expect(parseOsc777('other;x')).toBeNull();
  });
});

describe('parseOsc7', () => {
  it('extracts local paths', () => {
    expect(parseOsc7('file://host/home/me/my%20dir')).toBe('/home/me/my dir');
    expect(parseOsc7('file://host/C:/Users/me')).toBe('C:/Users/me');
    expect(parseOsc7('http://x/y')).toBeNull();
  });
});

describe('parseOsc633', () => {
  it('parses prompt and command marks', () => {
    expect(parseOsc633('A')).toEqual({ kind: 'promptStart' });
    expect(parseOsc633('B')).toEqual({ kind: 'promptEnd' });
    expect(parseOsc633('C')).toEqual({ kind: 'commandStart' });
    expect(parseOsc633('D;0')).toEqual({ kind: 'commandEnd', exitCode: 0 });
    expect(parseOsc633('D;127')).toEqual({ kind: 'commandEnd', exitCode: 127 });
    expect(parseOsc633('D')).toEqual({ kind: 'commandEnd' });
    expect(parseOsc633('D;x')).toEqual({ kind: 'commandEnd' });
    expect(parseOsc633('Z;1')).toBeNull();
  });

  it('unescapes command lines and cwd values', () => {
    expect(parseOsc633('E;echo a\\x3b b\\\\c\\x0anext')).toEqual({
      kind: 'commandLine',
      commandLine: 'echo a; b\\c\nnext',
    });
    expect(parseOsc633('E;ls;nonce123')).toEqual({ kind: 'commandLine', commandLine: 'ls' });
    expect(parseOsc633('P;Cwd=C:\\\\Users\\\\me')).toEqual({ kind: 'cwd', cwd: 'C:\\Users\\me' });
    expect(parseOsc633('P;Cwd=')).toBeNull();
    expect(parseOsc633('P;Other=1')).toBeNull();
    expect(unescapeOsc633('\\x1b[0m')).toBe('\x1b[0m');
  });
});
