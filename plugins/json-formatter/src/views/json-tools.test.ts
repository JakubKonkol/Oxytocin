import { describe as suite, expect, it } from 'vitest';
import { describe, errorOffset, format, minify, parse, position } from './json-tools';

suite('JSON Formatter', () => {
  it('formats with the chosen indentation and optionally sorted keys', () => {
    const text = '{"b":1,"a":[true,null,{"d":2,"c":"x"}]}';
    expect(format(text, { indent: '2', sortKeys: false })).toEqual({
      ok: true,
      text: '{\n  "b": 1,\n  "a": [\n    true,\n    null,\n    {\n      "d": 2,\n      "c": "x"\n    }\n  ]\n}',
      summary: 'object · 2 keys',
    });
    const sorted = format(text, { indent: 'tab', sortKeys: true });
    expect(sorted.ok && sorted.text).toBe(
      '{\n\t"a": [\n\t\ttrue,\n\t\tnull,\n\t\t{\n\t\t\t"c": "x",\n\t\t\t"d": 2\n\t\t}\n\t],\n\t"b": 1\n}',
    );
    const four = format('[1]', { indent: '4', sortKeys: false });
    expect(four).toEqual({ ok: true, text: '[\n    1\n]', summary: 'array · 1 item' });
  });

  it('minifies', () => {
    expect(minify('{\n  "z": 1,\n  "a": [ 1, 2 ]\n}', { sortKeys: true })).toEqual({
      ok: true,
      text: '{"a":[1,2],"z":1}',
      summary: 'object · 2 keys',
    });
  });

  it('reports errors with a line and column', () => {
    const result = parse('{\n  "a": 1,\n  "b": }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect([result.line, result.column]).toEqual([3, 8]);
    expect(errorOffset('[1, 2')).toBe(5);
    expect(errorOffset('{"a": tru}')).toBe(6);
    expect(errorOffset('{"a": [1, {"b": "x"}]}')).toBeNull();
    expect(errorOffset('{} x')).toBe(3);
    expect(parse('   ')).toEqual({ ok: false, error: 'Paste or type JSON' });
  });

  it('describes values and maps offsets to positions', () => {
    expect(describe('x')).toBe('string');
    expect(describe(null)).toBe('null');
    expect(describe({ a: 1 })).toBe('object · 1 key');
    expect(position('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });
});
