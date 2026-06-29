import { describe, it, expect } from 'vitest';

import { cliOptionsToSignOptions, validateOptsIgnore } from '../src/sign.js';

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

describe('cliOptionsToSignOptions', () => {
  it('forwards --ignore as the top-level ignore option', () => {
    const opts = cliOptionsToSignOptions({ ignore: ['foo', 'bar'] });
    expect(opts.ignore).toEqual(['foo', 'bar']);
  });

  it('forwards --signature-flags via optionsForFile', () => {
    const opts = cliOptionsToSignOptions({ 'signature-flags': 'library' });
    expect(opts.optionsForFile).toBeTypeOf('function');
    expect(opts.optionsForFile!('/some/path')).toEqual({ signatureFlags: 'library' });
  });

  it('omits options that were not provided', () => {
    expect(cliOptionsToSignOptions({})).toEqual({});
  });
});
