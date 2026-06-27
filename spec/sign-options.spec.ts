import { describe, it, expect } from 'vitest';

import { validateOptsIgnore } from '../src/sign.js';

describe('validateOptsIgnore', () => {
  it('wraps a single string in an array', () => {
    expect(validateOptsIgnore('foo')).toEqual(['foo']);
  });

  it('preserves an array value instead of dropping it', () => {
    const ignore = ['foo', 'bar'];
    expect(validateOptsIgnore(ignore)).toEqual(['foo', 'bar']);
  });

  it('preserves an array containing functions', () => {
    const fn = (file: string) => file.endsWith('.txt');
    const ignore = ['foo', fn];
    expect(validateOptsIgnore(ignore)).toEqual(['foo', fn]);
  });

  it('returns undefined when ignore is not set', () => {
    expect(validateOptsIgnore(undefined)).toBeUndefined();
  });
});
