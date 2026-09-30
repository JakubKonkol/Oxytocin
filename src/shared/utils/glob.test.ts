import { describe, expect, it } from 'vitest';
import { matchesAny, nameGlob, pathGlob } from './glob';

describe('nameGlob', () => {
  it('matches whole names case-insensitively', () => {
    expect(nameGlob('*password*').test('user_PASSWORD_hash')).toBe(true);
    expect(nameGlob('token').test('token')).toBe(true);
    expect(nameGlob('token').test('tokens')).toBe(false);
    expect(nameGlob('a?c').test('abc')).toBe(true);
    expect(nameGlob('a.c').test('abc')).toBe(false);
  });

  it('matchesAny checks every glob', () => {
    expect(matchesAny('api_secret', ['*password*', '*secret*'])).toBe(true);
    expect(matchesAny('email', ['*password*', '*secret*'])).toBe(false);
  });
});

describe('pathGlob', () => {
  it('handles **, * and ?', () => {
    expect(pathGlob('/**').test('/')).toBe(true);
    expect(pathGlob('/**').test('/api/users/1')).toBe(true);
    expect(pathGlob('/api/**').test('/api')).toBe(true);
    expect(pathGlob('/api/**').test('/api/users')).toBe(true);
    expect(pathGlob('/api/**').test('/apix')).toBe(false);
    expect(pathGlob('/users/*').test('/users/1')).toBe(true);
    expect(pathGlob('/users/*').test('/users/1/orders')).toBe(false);
    expect(pathGlob('/users/*/orders').test('/users/7/orders')).toBe(true);
    expect(pathGlob('admin/**').test('/admin/x')).toBe(true);
    expect(pathGlob('/v?/x').test('/v1/x')).toBe(true);
  });
});
