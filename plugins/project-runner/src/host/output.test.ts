import { describe, expect, it } from 'vitest';
import { browsable, detectPrompt, findListeningPort, findLocalUrls, LogBuffer, stripAnsi } from './output';

describe('output', () => {
  it('strips colours, OSC sequences and control characters', () => {
    expect(
      stripAnsi('\x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'),
    ).toBe('➜  Local:   http://localhost:5173/');
    expect(stripAnsi('\x1b]0;title\x07done\x1b]633;D;0\x1b\\')).toBe('done');
  });

  it('finds local URLs of common dev servers', () => {
    expect(findLocalUrls('  ➜  Local:   http://localhost:5173/')).toEqual(['http://localhost:5173/']);
    expect(findLocalUrls('  ➜  Network: http://192.168.1.5:5173/')).toEqual([]);
    expect(
      findLocalUrls('info: Microsoft.Hosting.Lifetime[14]\n      Now listening on: https://localhost:7043'),
    ).toEqual(['https://localhost:7043']);
    expect(findLocalUrls('Starting development server at http://127.0.0.1:8000/')).toEqual(['http://127.0.0.1:8000/']);
    expect(findLocalUrls('Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)')).toEqual([
      'http://localhost:8000',
    ]);
    expect(findLocalUrls('see https://nextjs.org/docs')).toEqual([]);
    expect(browsable('http://[::]:3000/.')).toBe('http://localhost:3000/');
  });

  it('finds ports announced without a URL', () => {
    expect(findListeningPort('Server listening on port 3000')).toBe(3000);
    expect(findListeningPort('[Nest] Application is running on: 4000')).toBe(4000);
    expect(findListeningPort('compiled 12 modules')).toBeUndefined();
  });

  it('keeps the last lines, handling partial chunks and carriage returns', () => {
    const log = new LogBuffer(3);
    expect(log.push('one\r\ntw')).toEqual(['one']);
    expect(log.push('o\nprogress 10%\rprogress 100%\nfour\nfi')).toEqual(['two', 'progress 100%', 'four']);
    // Three complete lines are kept, plus the unfinished one.
    expect(log.tail(10)).toEqual(['two', 'progress 100%', 'four', 'fi']);
    expect(log.tail(2)).toEqual(['four', 'fi']);
    log.clear();
    expect(log.tail(5)).toEqual([]);
  });

  it('detects questions an app waits on', () => {
    expect(detectPrompt('Would you like to use a different port? (Y/n)', ['? Port 4200 is already in use.'])).toEqual({
      text: 'Port 4200 is already in use.\nWould you like to use a different port? (Y/n)',
      yesNo: true,
    });
    expect(detectPrompt('? Would you like to run the app on another port instead? › (Y/n)', ['', 'compiled'])).toEqual({
      text: 'Would you like to run the app on another port instead? › (Y/n)',
      yesNo: true,
    });
    expect(detectPrompt('Overwrite the database? [y/N]', [])).toMatchObject({ yesNo: true });
    expect(detectPrompt('Enter the port to use: ', ['Server log line'])).toEqual({
      text: 'Enter the port to use:',
      yesNo: false,
    });
    // cmd's PAUSE (e.g. at the end of a batch script) waits for a key: Enter answers it.
    expect(detectPrompt('Press any key to continue . . . ', [])).toEqual({
      text: 'Press any key to continue . . .',
      yesNo: false,
      key: true,
    });
    expect(detectPrompt('Enter the port to use: ', [])).not.toHaveProperty('key');
    for (const progress of ['Building... 42%', '[=====>    ] 12/40', 'webpack compiling', ''])
      expect(detectPrompt(progress, [])).toBeUndefined();
  });

  it('keeps the unfinished line as the app last drew it', () => {
    const log = new LogBuffer();
    log.push('done\n? Pick one\x1b[2K\x1b[G? Port in use? (Y/n) ');
    expect(log.pending()).toBe('? Port in use? (Y/n) ');
    log.push('\n');
    expect(log.pending()).toBe('');
  });
});
